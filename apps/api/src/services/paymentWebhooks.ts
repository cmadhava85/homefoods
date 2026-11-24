import { and, eq } from "drizzle-orm";
import {
  cookLedger,
  orders,
  payments,
  platformEventLedger,
  settlements,
  type Db,
  type DbOrTx,
} from "@localmeals/db";
import {
  LogEvent,
  bindTrace,
  createServiceLogger,
  orderTriageFields,
} from "@localmeals/observability";
import { enqueueOutbox } from "./outboxEnqueue.js";
import { assertTransition, lineTotalPaise, type OrderState } from "@localmeals/domain";
import type { GatewayWebhookEvent } from "@localmeals/adapters";
import { markOrderPaid } from "./orders.js";

const payLog = createServiceLogger("localmeals-api");

function bindTraceFromEventOrOrders(
  event: GatewayWebhookEvent,
  rows: {
    traceId: string;
    publicId: string;
    checkoutId: string | null;
    customerMobile?: string;
    cookId?: string;
    id?: number;
    status?: string;
    mealType?: string;
    serviceDate?: string;
  }[],
) {
  const row = rows[0];
  const fromNotes = event.notes?.traceId?.trim();
  const base = {
    publicId: row?.publicId ?? event.orderPublicId,
    checkoutId: row?.checkoutId,
    customerMobile: row?.customerMobile,
    cookId: row?.cookId,
    orderId: row?.id,
    status: row?.status,
    mealType: row?.mealType,
    serviceDate: row?.serviceDate,
    amountPaise: event.amountPaise,
  };
  if (fromNotes) {
    bindTrace({ traceId: fromNotes, ...base });
    return;
  }
  if (row?.traceId) {
    bindTrace({ traceId: row.traceId, ...base });
  }
}

async function audit(
  db: DbOrTx,
  event: GatewayWebhookEvent,
  extra: { orderId?: number; cookId?: string; mobile?: string; traceId?: string } = {},
) {
  await db.insert(platformEventLedger).values({
    associatedMobile: extra.mobile ?? null,
    orderId: extra.orderId ?? null,
    cookId: extra.cookId ?? null,
    channel: "WEB_STOREFRONT",
    eventName: `GATEWAY_${event.kind}`,
    rawPayload: {
      event: event.event,
      gatewayTxnId: event.gatewayTxnId,
      paymentId: event.paymentId,
      refundId: event.refundId,
      transferId: event.transferId,
      payoutId: event.payoutId,
      settlementGatewayId: event.settlementGatewayId,
      accountId: event.accountId,
      status: event.status,
      amountPaise: event.amountPaise,
      utr: event.utr,
      notes: event.notes,
      razorpayEvent: event.event,
      traceId: extra.traceId ?? event.notes?.traceId ?? null,
      // Keep raw webhook for ops (Razorpay payloads are modest).
      raw: event.raw ?? null,
    },
  });
}

async function findOrdersForPayment(db: Db, event: GatewayWebhookEvent) {
  if (event.gatewayTxnId) {
    const byTxn = await db.query.orders.findMany({
      where: (t, { eq: e }) => e(t.gatewayTxnId, event.gatewayTxnId!),
    });
    if (byTxn.length) return byTxn;
  }
  if (event.orderPublicId) {
    const one = await db.query.orders.findFirst({
      where: (t, { eq: e }) => e(t.publicId, event.orderPublicId!),
    });
    if (one) return [one];
  }
  return [];
}

async function markPaymentFailed(db: Db, event: GatewayWebhookEvent) {
  const rows = await findOrdersForPayment(db, event);
  bindTraceFromEventOrOrders(event, rows);
  if (!rows.length) {
    await audit(db, event);
    return { ok: true, kind: event.kind, matched: 0 };
  }

  return db.transaction(async (tx) => {
    const updated = [];
    for (const order of rows) {
      if (order.status !== "AWAITING_PAYMENT" && order.status !== "CONFIRMING_PAYMENT") {
        continue;
      }
      assertTransition(order.status as OrderState, "FAILED");
      const [row] = await tx
        .update(orders)
        .set({ status: "FAILED", updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.status, order.status)))
        .returning();
      if (!row) continue;
      await tx
        .update(payments)
        .set({ status: "FAILED", rawPayload: event.raw as object })
        .where(and(eq(payments.orderId, order.id), eq(payments.kind, "CHARGE")));
      await enqueueOutbox(tx, "OrderPaymentFailed", {
        orderId: order.id,
        publicId: order.publicId,
        customerMobile: order.customerMobile,
        reason: event.event,
      });
      updated.push(row);
      await audit(tx, event, {
        orderId: order.id,
        cookId: order.cookId,
        mobile: order.customerMobile,
        traceId: order.traceId,
      });
      payLog.warn(
        {
          event: LogEvent.PAYMENT_FAILED,
          kind: event.kind,
          ...orderTriageFields({
            traceId: order.traceId,
            publicId: order.publicId,
            checkoutId: order.checkoutId,
            orderId: order.id,
            customerMobile: order.customerMobile,
            cookId: order.cookId,
            status: "FAILED",
            amountPaise: event.amountPaise,
            mealType: order.mealType,
            serviceDate: order.serviceDate,
            itemName: order.itemName,
          }),
          gatewayTxnId: event.gatewayTxnId,
        },
        "payment failed",
      );
    }
    return { ok: true, kind: event.kind, matched: updated.length, orders: updated };
  });
}

async function markPaymentAuthorized(db: Db, event: GatewayWebhookEvent) {
  const rows = await findOrdersForPayment(db, event);
  bindTraceFromEventOrOrders(event, rows);
  return db.transaction(async (tx) => {
    const updated = [];
    for (const order of rows) {
      if (order.status !== "AWAITING_PAYMENT") continue;
      assertTransition(order.status as OrderState, "CONFIRMING_PAYMENT");
      const [row] = await tx
        .update(orders)
        .set({ status: "CONFIRMING_PAYMENT", updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), eq(orders.status, "AWAITING_PAYMENT")))
        .returning();
      if (!row) continue;
      updated.push(row);
      await audit(tx, event, {
        orderId: order.id,
        cookId: order.cookId,
        mobile: order.customerMobile,
      });
      payLog.info(
        {
          event: LogEvent.PAYMENT_CONFIRMING,
          kind: event.kind,
          ...orderTriageFields({
            traceId: order.traceId,
            publicId: order.publicId,
            checkoutId: order.checkoutId,
            orderId: order.id,
            customerMobile: order.customerMobile,
            cookId: order.cookId,
            status: "CONFIRMING_PAYMENT",
            amountPaise: event.amountPaise,
            mealType: order.mealType,
            serviceDate: order.serviceDate,
            itemName: order.itemName,
          }),
          gatewayTxnId: event.gatewayTxnId,
        },
        "payment confirming",
      );
    }
    if (!updated.length) await audit(tx, event);
    return { ok: true, kind: event.kind, matched: updated.length, orders: updated };
  });
}

async function syncRefundProcessed(db: Db, event: GatewayWebhookEvent) {
  const rows = await findOrdersForPayment(db, event);
  bindTraceFromEventOrOrders(event, rows);
  if (!rows.length) {
    await audit(db, event);
    return { ok: true, kind: event.kind, matched: 0 };
  }

  const updated = await db.transaction(async (tx) => {
    const out = [];
    for (const order of rows) {
      if (order.status === "REFUNDED") {
        // Redelivered refund webhook: ON CONFLICT, not try/catch — a failed statement would abort
        // this transaction and turn a harmless retry into a 5xx (Razorpay then retries forever).
        await tx
          .insert(payments)
          .values({
            orderId: order.id,
            kind: "REFUND",
            amountPaise: event.amountPaise ?? 0,
            status: "REFUNDED",
            gatewayTxnId: event.refundId ?? `refund_${order.gatewayTxnId}`,
            rawPayload: event.raw as object,
            idempotencyKey: event.refundId ? `rzp_refund_${event.refundId}` : undefined,
          })
          .onConflictDoNothing();
        await audit(tx, event, {
          orderId: order.id,
          cookId: order.cookId,
          mobile: order.customerMobile,
        });
        continue;
      }
      if (
        ![
          "PAID",
          "COOKING",
          "PACKED",
          "DISPATCHED",
          "DELAYED",
          "RETURNED_TO_KITCHEN",
          "LOGISTICS_EXCEPTION",
          "CANCEL_REQUESTED",
        ].includes(order.status)
      ) {
        await audit(tx, event, { orderId: order.id, cookId: order.cookId });
        continue;
      }
      assertTransition(order.status as OrderState, "REFUNDED");
      const [row] = await tx
        .update(orders)
        .set({
          status: "REFUNDED",
          settlementHold: true,
          updatedAt: new Date(),
        })
        .where(and(eq(orders.id, order.id), eq(orders.status, order.status)))
        .returning();
      if (!row) continue;
      await tx
        .insert(payments)
        .values({
          orderId: order.id,
          kind: "REFUND",
          amountPaise: event.amountPaise ?? lineTotalPaise(order),
          status: "REFUNDED",
          gatewayTxnId: event.refundId ?? `refund_${order.gatewayTxnId}`,
          rawPayload: event.raw as object,
          idempotencyKey: event.refundId ? `rzp_refund_${event.refundId}` : undefined,
        })
        .onConflictDoNothing();
      await enqueueOutbox(tx, "OrderRefunded", {
        orderId: order.id,
        publicId: order.publicId,
        customerMobile: order.customerMobile,
        source: "gateway_webhook",
        refundId: event.refundId,
      });
      out.push(row);
      await audit(tx, event, {
        orderId: order.id,
        cookId: order.cookId,
        mobile: order.customerMobile,
      });
    }
    return out;
  });
  return { ok: true, kind: event.kind, matched: updated.length, orders: updated };
}

async function updateSettlementStatus(
  db: Db,
  event: GatewayWebhookEvent,
  status: string,
) {
  const gatewayId = event.settlementGatewayId ?? event.payoutId ?? event.transferId;
  let settlement = gatewayId
    ? await db.query.settlements.findFirst({
        where: (t, { eq: e }) => e(t.gatewayBatchId, gatewayId),
      })
    : null;

  // Fallback: match notes.settlementId as our numeric id
  if (!settlement && event.notes?.settlementId && /^\d+$/.test(event.notes.settlementId)) {
    settlement = await db.query.settlements.findFirst({
      where: (t, { eq: e }) => e(t.id, Number(event.notes!.settlementId)),
    });
  }

  if (!settlement) {
    await audit(db, event);
    await enqueueOutbox(db, "CookPayoutWebhook", {
        kind: event.kind,
        event: event.event,
        gatewayId,
        status,
        utr: event.utr,
        amountPaise: event.amountPaise,
        accountId: event.accountId,
      });
    return { ok: true, kind: event.kind, matched: 0, status };
  }

  const [updated] = await db
    .update(settlements)
    .set({ status })
    .where(eq(settlements.id, settlement.id))
    .returning();

  await db.insert(cookLedger).values({
    cookId: settlement.cookId,
    settlementId: settlement.id,
    entryType: `GATEWAY_${event.kind}`,
    amountPaise: event.amountPaise ?? settlement.netPaise,
    note: [
      event.event,
      event.utr ? `UTR ${event.utr}` : null,
      event.transferId ? `transfer ${event.transferId}` : null,
      event.payoutId ? `payout ${event.payoutId}` : null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  await enqueueOutbox(db, "CookPayoutWebhook", {
      kind: event.kind,
      settlementId: settlement.id,
      cookId: settlement.cookId,
      status,
      utr: event.utr,
      gatewayId,
    });

  await audit(db, event, { cookId: settlement.cookId });
  return { ok: true, kind: event.kind, matched: 1, settlement: updated };
}

async function handleRouteAccount(db: Db, event: GatewayWebhookEvent) {
  let cook = null;
  if (event.accountId) {
    cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.payoutBeneficiaryRef, event.accountId!),
    });
  }
  await audit(db, event, { cookId: cook?.id });
  await enqueueOutbox(db, "CookRouteAccountWebhook", {
      event: event.event,
      accountId: event.accountId,
      status: event.status,
      cookId: cook?.id ?? null,
      kitchenName: cook?.kitchenName ?? null,
    });
  return { ok: true, kind: event.kind, cookId: cook?.id ?? null, status: event.status };
}

/**
 * Single entry for POST /webhooks/payments — covers pay, fail, refund, Route transfer, payout, settlement.
 */
export async function handlePaymentWebhook(db: Db, event: GatewayWebhookEvent) {
  switch (event.kind) {
    case "PAYMENT_CAPTURED": {
      if (!event.gatewayTxnId && !event.orderPublicId) {
        await audit(db, event);
        return { ok: true, kind: event.kind, ignored: true, reason: "no_gateway_txn" };
      }
      if (event.notes?.traceId) {
        bindTrace({
          traceId: event.notes.traceId,
          publicId: event.orderPublicId,
        });
      }
      try {
        const order = await markOrderPaid(db, {
          gatewayTxnId: event.gatewayTxnId,
          orderPublicId: event.orderPublicId,
          paymentId: event.paymentId,
          paidAmountPaise: event.amountPaise,
          rawPayload: event.raw,
        });
        await audit(db, event, {
          orderId: order.id,
          cookId: order.cookId,
          mobile: order.customerMobile,
          traceId: order.traceId,
        });
        return { ok: true, kind: event.kind, order, traceId: order.traceId };
      } catch (err) {
        // Razorpay retries 4xx forever. Unknown plink (test pay / other env) must 200-ack.
        const msg = err instanceof Error ? err.message : String(err);
        if (/order not found for txn/i.test(msg)) {
          await audit(db, event);
          return {
            ok: true,
            kind: event.kind,
            ignored: true,
            reason: "order_not_found",
            gatewayTxnId: event.gatewayTxnId,
            orderPublicId: event.orderPublicId,
          };
        }
        throw err;
      }
    }
    case "PAYMENT_AUTHORIZED":
      return markPaymentAuthorized(db, event);
    case "PAYMENT_FAILED":
      return markPaymentFailed(db, event);
    case "REFUND_PROCESSED":
      return syncRefundProcessed(db, event);
    case "REFUND_FAILED":
      await audit(db, event);
      await enqueueOutbox(db, "OrderRefundFailed", {
          refundId: event.refundId,
          gatewayTxnId: event.gatewayTxnId,
          orderPublicId: event.orderPublicId,
          event: event.event,
        });
      return { ok: true, kind: event.kind };
    case "TRANSFER_PROCESSED":
      return updateSettlementStatus(db, event, "TRANSFER_PROCESSED");
    case "TRANSFER_FAILED":
      return updateSettlementStatus(db, event, "TRANSFER_FAILED");
    case "PAYOUT_PROCESSED":
      return updateSettlementStatus(db, event, "PAYOUT_PROCESSED");
    case "PAYOUT_FAILED":
      return updateSettlementStatus(db, event, "PAYOUT_FAILED");
    case "PAYOUT_REVERSED":
      return updateSettlementStatus(db, event, "PAYOUT_REVERSED");
    case "SETTLEMENT_PROCESSED":
      await audit(db, event);
      await enqueueOutbox(db, "PlatformSettlementProcessed", {
          settlementGatewayId: event.settlementGatewayId,
          amountPaise: event.amountPaise,
          utr: event.utr,
        });
      return { ok: true, kind: event.kind, utr: event.utr };
    case "ROUTE_ACCOUNT":
      return handleRouteAccount(db, event);
    case "IGNORED":
    default:
      await audit(db, event);
      return { ok: true, kind: "IGNORED", event: event.event };
  }
}
