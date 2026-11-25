import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { cookLedger, orders, settlements, type Db } from "@localmeals/db";
import { LogEvent, createServiceLogger, newTraceId } from "@localmeals/observability";
import { enqueueOutbox } from "./outboxEnqueue.js";
import { commissionPaise, lineFoodNetPaise, serviceDateISO } from "@localmeals/domain";
import { getPaymentProvider, getWhatsAppProvider, isMockPayments } from "@localmeals/adapters";

const log = createServiceLogger("localmeals-api");

function foodNetPaise(o: {
  foodPaise: number;
  qty: number;
  foodDiscountPaise?: number | null;
}) {
  return lineFoodNetPaise(o);
}

/** Platform commission on a line, from the rate snapshotted when the order was placed. */
function lineCommissionPaise(o: {
  foodPaise: number;
  qty: number;
  foodDiscountPaise?: number | null;
  commissionBps?: number | null;
}) {
  return commissionPaise(foodNetPaise(o), o.commissionBps ?? 0);
}

/**
 * Settle unsettled DELIVERED orders with serviceDate ≤ businessDate.
 * Dinner/late deliveries after an earlier same-day run append onto the existing batch.
 */
export async function runEodSettlement(db: Db, businessDate = serviceDateISO()) {
  const { assertFeatureEnabled } = await import("./featureFlags.js");
  await assertFeatureEnabled(
    db,
    "eod_settlement_enabled",
    "EOD settlement is temporarily paused by admin",
  );
  const delivered = await db.query.orders.findMany({
    where: (t, { eq: e, and: a, isNull: n, lte: l }) =>
      a(
        l(t.serviceDate, businessDate),
        e(t.status, "DELIVERED"),
        e(t.settlementHold, false),
        n(t.settlementId),
      ),
  });

  const byCookDate = new Map<string, typeof delivered>();
  for (const o of delivered) {
    const key = `${o.cookId}|${o.serviceDate}`;
    const list = byCookDate.get(key) ?? [];
    list.push(o);
    byCookDate.set(key, list);
  }

  const batches = [];
  const skipped: Array<Record<string, unknown>> = [];
  const pay = getPaymentProvider();

  for (const [key, cookOrders] of byCookDate) {
    const [cookId, settleDate] = key.split("|");
    if (cookOrders.reduce((n, o) => n + foodNetPaise(o), 0) <= 0) {
      skipped.push({ cookId, businessDate: settleDate, reason: "zero_net" });
      continue;
    }

    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.id, cookId),
    });

    // Concurrency-safe claim (Scheduler retry + worker + manual run can overlap):
    // - one settlement row per cook/day (ON CONFLICT), locked for the claim;
    // - orders are attached only if still unsettled, and totals grow by what *this* run claimed.
    const claim = await db.transaction(async (tx) => {
      await tx
        .insert(settlements)
        .values({
          cookId,
          businessDate: settleDate,
          grossPaise: 0,
          feesPaise: 0,
          clawbackPaise: 0,
          netPaise: 0,
          orderCount: 0,
          gatewayBatchId: null,
          status: "PENDING_TRANSFER",
        })
        .onConflictDoNothing();
      await tx.execute(
        sql`select id from settlements where cook_id = ${cookId} and business_date = ${settleDate} for update`,
      );
      const row = await tx.query.settlements.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.cookId, cookId), e(t.businessDate, settleDate)),
      });
      if (!row) throw new Error("settlement row missing after upsert");

      const claimedOrders = await tx
        .update(orders)
        .set({ settlementId: row.id, updatedAt: new Date() })
        .where(
          and(
            inArray(
              orders.id,
              cookOrders.map((o) => o.id),
            ),
            isNull(orders.settlementId),
            eq(orders.status, "DELIVERED"),
            eq(orders.settlementHold, false),
          ),
        )
        .returning();
      if (!claimedOrders.length) {
        if (row.orderCount === 0) await tx.delete(settlements).where(eq(settlements.id, row.id));
        return null;
      }
      const claimedGross = claimedOrders.reduce((n, o) => n + foodNetPaise(o), 0);
      const claimedFees = claimedOrders.reduce((n, o) => n + lineCommissionPaise(o), 0);
      const claimedNet = claimedGross - claimedFees;
      const [updated] = await tx
        .update(settlements)
        .set({
          grossPaise: sql`${settlements.grossPaise} + ${claimedGross}`,
          feesPaise: sql`${settlements.feesPaise} + ${claimedFees}`,
          netPaise: sql`${settlements.netPaise} + ${claimedNet}`,
          orderCount: sql`${settlements.orderCount} + ${claimedOrders.length}`,
          status: "PENDING_TRANSFER",
        })
        .where(eq(settlements.id, row.id))
        .returning();
      return {
        draft: updated,
        previousGatewayBatchId: row.gatewayBatchId,
        isAppend: row.orderCount > 0,
        claimedOrders,
        addNet: claimedNet,
        addFees: claimedFees,
      };
    });
    if (!claim) {
      skipped.push({ cookId, businessDate: settleDate, reason: "already_claimed" });
      continue;
    }
    const { draft, isAppend, addNet, addFees, previousGatewayBatchId } = claim;
    const settledOrders = claim.claimedOrders;

    const { applyPendingClawbacksToSettlement } = await import("./cookClawback.js");
    const clawbackPaise = isAppend
      ? 0
      : await applyPendingClawbacksToSettlement(db, {
          cookId,
          settlementId: draft.id,
          availablePaise: addNet,
          businessDate: settleDate,
        });
    const transferPaise = Math.max(0, addNet - clawbackPaise);

    let gatewayBatchId = `local_settle_${cookId.slice(0, 8)}_${settleDate}`;
    let status = "COMPLETED";
    let transferError: string | null = null;

    const accountId = cook?.payoutBeneficiaryRef?.trim();
    if (transferPaise <= 0) {
      status = "COMPLETED";
      gatewayBatchId = `${isAppend ? "append_" : ""}clawback_${cookId.slice(0, 8)}_${settleDate}`;
    } else if (!accountId) {
      const hasManual =
        Boolean(cook?.payoutUpiId?.trim()) || Boolean(cook?.payoutAccountNote?.trim());
      status = "AWAITING_MANUAL_PAY";
      gatewayBatchId = `${isAppend ? "manual_append_" : "manual_"}${cookId.slice(0, 8)}_${settleDate}`;
      transferError = hasManual
        ? "Pay cook via UPI/bank in Admin → Payouts (Route not linked)"
        : "Add cook UPI or bank note in Admin → Cooks, then Mark paid";
      if (!hasManual) {
        skipped.push({
          cookId,
          settlementId: draft.id,
          reason: "missing_manual_payout_details",
        });
      }
    } else {
      try {
        const settleTraceId = newTraceId();
        log.info(
          {
            event: LogEvent.THIRD_PARTY_REQUEST,
            provider: "razorpay",
            action: "transferToLinkedAccount",
            traceId: settleTraceId,
            settlementId: draft.id,
            cookId,
            amountPaise: transferPaise,
            businessDate: settleDate,
            append: isAppend,
          },
          "razorpay transfer",
        );
        const transfer = await pay.transferToLinkedAccount({
          accountId,
          amountPaise: transferPaise,
          notes: {
            settlementId: String(draft.id),
            businessDate: settleDate,
            cookId,
            orderCount: String(settledOrders.length),
            clawbackPaise: String(clawbackPaise),
            commissionPaise: String(addFees),
            append: isAppend ? "1" : "0",
            traceId: settleTraceId.slice(0, 40),
          },
        });
        gatewayBatchId = transfer.transferId;
        status =
          transfer.status === "processed" || isMockPayments()
            ? "COMPLETED"
            : "TRANSFER_INITIATED";
      } catch (e) {
        transferError = (e as Error).message;
        status = "TRANSFER_FAILED";
        if (!isMockPayments()) {
          skipped.push({
            cookId,
            settlementId: draft.id,
            reason: "transfer_failed",
            error: transferError,
          });
        }
      }
    }

    // Totals were already incremented atomically in the claim; only fold in this run's clawback.
    // On append keep the first transfer's id (later transfers carry notes.settlementId for webhooks).
    const [batch] = await db
      .update(settlements)
      .set({
        gatewayBatchId: isAppend && previousGatewayBatchId ? previousGatewayBatchId : gatewayBatchId,
        status,
        clawbackPaise: sql`${settlements.clawbackPaise} + ${clawbackPaise}`,
        netPaise: sql`greatest(0, ${settlements.netPaise} - ${clawbackPaise})`,
      })
      .where(eq(settlements.id, draft.id))
      .returning();

    await db.insert(cookLedger).values({
      cookId,
      settlementId: batch.id,
      entryType: status === "TRANSFER_FAILED" ? "EOD_TRANSFER_FAILED" : "EOD_CREDIT",
      amountPaise: transferPaise,
      note: [
        `${isAppend ? "Catch-up" : "Settlement"} ${settleDate} · ${settledOrders.length} orders`,
        addFees > 0 ? `commission −₹${(addFees / 100).toFixed(2)}` : null,
        clawbackPaise > 0 ? `clawback −₹${(clawbackPaise / 100).toFixed(0)}` : null,
        gatewayBatchId,
        transferError ? `err: ${transferError}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });

    await enqueueOutbox(db, "SettlementBatchCompleted", {
      settlementId: batch.id,
      cookId,
      businessDate: settleDate,
      netPaise: batch.netPaise,
      clawbackPaise: batch.clawbackPaise,
      orderCount: settledOrders.length,
      gatewayBatchId,
      status,
      transferError,
      append: isAppend,
    });

    const settleFields = {
      settlementId: batch.id,
      cookId,
      businessDate: settleDate,
      netPaise: batch.netPaise,
      clawbackPaise: batch.clawbackPaise,
      orderCount: settledOrders.length,
      status,
      gatewayBatchId,
    };
    if (status === "TRANSFER_FAILED" || status === "MISSING_PAYOUT_ACCOUNT") {
      log.error(
        { event: LogEvent.SETTLEMENT_BATCH_FAILED, ...settleFields, transferError },
        "settlement batch failed",
      );
    } else {
      log.info(
        { event: LogEvent.SETTLEMENT_BATCH_COMPLETED, ...settleFields },
        "settlement batch completed",
      );
    }

    if (cook && status !== "TRANSFER_FAILED" && status !== "MISSING_PAYOUT_ACCOUNT") {
      const feeLine = addFees > 0 ? ` (after ₹${(addFees / 100).toFixed(2)} LocalMeals commission)` : "";
      const clawLine =
        clawbackPaise > 0
          ? ` · recovery −₹${(clawbackPaise / 100).toFixed(0)} (prior refunds)`
          : "";
      await getWhatsAppProvider().send({
        to: cook.mobileNumber,
        body: `${isAppend ? "Catch-up" : "EOD"} settlement ${settleDate}: ${settledOrders.length} orders · ₹${(transferPaise / 100).toFixed(2)}${feeLine}${clawLine} · ref ${gatewayBatchId}`,
      });
    }

    if (status !== "TRANSFER_FAILED" || isMockPayments()) {
      batches.push(batch);
    }
  }

  return {
    businessDate,
    batches,
    skipped,
    orderCount: batches.reduce((n, b) => n + b.orderCount, 0),
  };
}
