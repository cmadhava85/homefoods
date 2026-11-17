import { eq } from "drizzle-orm";
import { cookLedger, orders, settlements, type Db } from "@localmeals/db";
import { LogEvent, createServiceLogger } from "@localmeals/observability";
import { enqueueOutbox } from "./outboxEnqueue.js";
import { serviceDateISO } from "@localmeals/domain";
import { getPaymentProvider, getWhatsAppProvider, isMockPayments } from "@localmeals/adapters";

const log = createServiceLogger("localmeals-api");

export async function runEodSettlement(db: Db, businessDate = serviceDateISO()) {
  const { assertFeatureEnabled } = await import("./featureFlags.js");
  await assertFeatureEnabled(
    db,
    "eod_settlement_enabled",
    "EOD settlement is temporarily paused by admin",
  );
  const delivered = await db.query.orders.findMany({
    where: (t, { eq: e, and: a, isNull: n }) =>
      a(
        e(t.serviceDate, businessDate),
        e(t.status, "DELIVERED"),
        e(t.settlementHold, false),
        n(t.settlementId),
      ),
  });

  const byCook = new Map<string, typeof delivered>();
  for (const o of delivered) {
    const list = byCook.get(o.cookId) ?? [];
    list.push(o);
    byCook.set(o.cookId, list);
  }

  const batches = [];
  const skipped = [];
  const pay = getPaymentProvider();

  for (const [cookId, cookOrders] of byCook) {
    const existing = await db.query.settlements.findFirst({
      where: (t, { eq: e, and: a }) =>
        a(e(t.cookId, cookId), e(t.businessDate, businessDate)),
    });
    if (existing) {
      skipped.push({ cookId, settlementId: existing.id, reason: "already_settled" });
      continue;
    }

    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.id, cookId),
    });

    const grossPaise = cookOrders.reduce(
      (n, o) => n + Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0)),
      0,
    );
    const feesPaise = 0;

    if (grossPaise <= 0) {
      skipped.push({ cookId, reason: "zero_net" });
      continue;
    }

    // Insert settlement first (PENDING), then apply clawbacks + transfer
    const draft = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(settlements)
        .values({
          cookId,
          businessDate,
          grossPaise,
          feesPaise,
          clawbackPaise: 0,
          netPaise: grossPaise,
          orderCount: cookOrders.length,
          gatewayBatchId: null,
          status: "PENDING_TRANSFER",
        })
        .returning();

      for (const o of cookOrders) {
        await tx
          .update(orders)
          .set({ settlementId: row.id, updatedAt: new Date() })
          .where(eq(orders.id, o.id));
      }

      return row;
    });

    const { applyPendingClawbacksToSettlement } = await import("./cookClawback.js");
    const clawbackPaise = await applyPendingClawbacksToSettlement(db, {
      cookId,
      settlementId: draft.id,
      availablePaise: grossPaise,
      businessDate,
    });
    const netPaise = Math.max(0, grossPaise - clawbackPaise);

    let gatewayBatchId = `local_settle_${cookId.slice(0, 8)}_${businessDate}`;
    let status = "COMPLETED";
    let transferError: string | null = null;

    const accountId = cook?.payoutBeneficiaryRef?.trim();
    if (netPaise <= 0) {
      // Fully offset by prior refund recoveries — nothing to pay today
      status = "COMPLETED";
      gatewayBatchId = `clawback_${cookId.slice(0, 8)}_${businessDate}`;
      transferError = null;
    } else if (!accountId) {
      // Route blocked / not linked — ops pays via UPI (Admin → Payouts)
      const hasManual =
        Boolean(cook?.payoutUpiId?.trim()) || Boolean(cook?.payoutAccountNote?.trim());
      status = "AWAITING_MANUAL_PAY";
      gatewayBatchId = `manual_${cookId.slice(0, 8)}_${businessDate}`;
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
        const transfer = await pay.transferToLinkedAccount({
          accountId,
          amountPaise: netPaise,
          notes: {
            settlementId: String(draft.id),
            businessDate,
            cookId,
            orderCount: String(cookOrders.length),
            clawbackPaise: String(clawbackPaise),
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
          // Leave orders linked to settlement for retry/ops; don't throw whole EOD
          skipped.push({
            cookId,
            settlementId: draft.id,
            reason: "transfer_failed",
            error: transferError,
          });
        }
      }
    }

    const [batch] = await db
      .update(settlements)
      .set({
        gatewayBatchId,
        status,
        clawbackPaise,
        netPaise,
      })
      .where(eq(settlements.id, draft.id))
      .returning();

    await db.insert(cookLedger).values({
      cookId,
      settlementId: batch.id,
      entryType: status === "TRANSFER_FAILED" ? "EOD_TRANSFER_FAILED" : "EOD_CREDIT",
      amountPaise: netPaise,
      note: [
        `Settlement ${businessDate} · ${cookOrders.length} orders`,
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
      businessDate,
      netPaise,
      clawbackPaise,
      orderCount: cookOrders.length,
      gatewayBatchId,
      status,
      transferError,
    });

    const settleFields = {
      settlementId: batch.id,
      cookId,
      businessDate,
      netPaise,
      clawbackPaise,
      orderCount: cookOrders.length,
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
      const clawLine =
        clawbackPaise > 0
          ? ` · recovery −₹${(clawbackPaise / 100).toFixed(0)} (prior refunds)`
          : "";
      await getWhatsAppProvider().send({
        to: cook.mobileNumber,
        body: `EOD settlement ${businessDate}: ${cookOrders.length} orders · net ₹${(netPaise / 100).toFixed(2)}${clawLine} · ref ${gatewayBatchId}`,
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
