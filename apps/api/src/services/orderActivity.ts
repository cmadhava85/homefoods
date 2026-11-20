import { desc, sql } from "drizzle-orm";
import { outbox, platformEventLedger, type Db } from "@localmeals/db";

type LedgerChannel = "VOICE_IVR" | "WHATSAPP_BOT" | "WEB_STOREFRONT" | "SYSTEM_CRON" | "ADMIN";

/** Append a support-visible row for this order. */
export async function recordOrderActivity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Db | any,
  input: {
    orderId: number;
    customerMobile?: string | null;
    cookId?: string | null;
    channel?: LedgerChannel;
    eventName: string;
    payload?: Record<string, unknown>;
  },
) {
  await db.insert(platformEventLedger).values({
    associatedMobile: input.customerMobile ?? null,
    orderId: input.orderId,
    cookId: input.cookId ?? null,
    channel: input.channel ?? "SYSTEM_CRON",
    eventName: input.eventName.slice(0, 100),
    rawPayload: input.payload ?? {},
  });
}

function lineTotalPaise(o: {
  foodPaise: number;
  qty: number;
  foodDiscountPaise?: number | null;
  deliveryPaise: number;
  platformFeePaise: number;
}) {
  return (
    Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0)) +
    o.deliveryPaise +
    o.platformFeePaise
  );
}

/**
 * Resolve an order for ops lookup: LM-… publicId, checkoutId, trc_…, or gateway txn id.
 */
export async function resolveSupportOrder(db: Db, rawKey: string) {
  const key = rawKey.trim();
  if (!key) throw new Error("Order not found");

  const byPublic = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, key),
  });
  if (byPublic) return { order: byPublic, matchedBy: "publicId" as const };

  const byCheckout = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.checkoutId, key),
    orderBy: (t, { asc: a }) => [a(t.serviceDate), a(t.id)],
  });
  if (byCheckout) return { order: byCheckout, matchedBy: "checkoutId" as const };

  const byTrace = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.traceId, key),
    orderBy: (t, { asc: a }) => [a(t.serviceDate), a(t.id)],
  });
  if (byTrace) return { order: byTrace, matchedBy: "traceId" as const };

  const byGateway = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.gatewayTxnId, key),
  });
  if (byGateway) return { order: byGateway, matchedBy: "gatewayTxnId" as const };

  throw new Error("Order not found");
}

async function listRelatedOutbox(
  db: Db,
  opts: {
    publicIds: string[];
    checkoutId: string | null;
    orderIds: number[];
  },
) {
  const publicIds = opts.publicIds.filter(Boolean);
  const clauses: ReturnType<typeof sql>[] = [];

  for (const pid of publicIds) {
    clauses.push(sql`(${outbox.payload}->>'publicId') = ${pid}`);
    clauses.push(sql`(${outbox.payload}->>'orderPublicId') = ${pid}`);
  }
  if (opts.checkoutId) {
    clauses.push(sql`(${outbox.payload}->>'checkoutId') = ${opts.checkoutId}`);
  }
  for (const oid of opts.orderIds) {
    clauses.push(sql`(${outbox.payload}->>'orderId') = ${String(oid)}`);
  }

  if (!clauses.length) return [];

  const combined = clauses.reduce((acc, clause) =>
    acc ? sql`(${acc}) OR (${clause})` : clause,
  );

  const rows = await db
    .select({
      id: outbox.id,
      eventName: outbox.eventName,
      attempts: outbox.attempts,
      lastError: outbox.lastError,
      processedAt: outbox.processedAt,
      createdAt: outbox.createdAt,
      payload: outbox.payload,
    })
    .from(outbox)
    .where(combined)
    .orderBy(desc(outbox.createdAt))
    .limit(40);

  return rows.map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const corr =
      payload._corr && typeof payload._corr === "object"
        ? (payload._corr as Record<string, unknown>)
        : null;
    const pending = !r.processedAt;
    const failed =
      Boolean(r.lastError) &&
      (Boolean(r.processedAt) || (r.attempts ?? 0) > 0);
    return {
      id: r.id,
      eventName: r.eventName,
      attempts: r.attempts,
      lastError: r.lastError,
      processedAt: r.processedAt,
      createdAt: r.createdAt,
      status: pending ? ("pending" as const) : failed ? ("failed" as const) : ("ok" as const),
      publicId:
        (typeof payload.publicId === "string" && payload.publicId) ||
        (typeof payload.orderPublicId === "string" && payload.orderPublicId) ||
        null,
      checkoutId: typeof payload.checkoutId === "string" ? payload.checkoutId : null,
      traceId:
        (corr && typeof corr.traceId === "string" && corr.traceId) ||
        (typeof payload.traceId === "string" && payload.traceId) ||
        null,
    };
  });
}

/**
 * Ops support bundle: order (+ week siblings), payments, outbox, ledger activity, admin actions.
 * `key` may be publicId, checkoutId, traceId, or gatewayTxnId.
 */
export async function getOrderSupportBundle(db: Db, key: string) {
  const { order, matchedBy } = await resolveSupportOrder(db, key);

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, order.cookId),
    columns: {
      id: true,
      kitchenName: true,
      slugHandle: true,
      mobileNumber: true,
    },
  });

  const siblingRows = order.checkoutId
    ? await db.query.orders.findMany({
        where: (t, { eq: e }) => e(t.checkoutId, order.checkoutId!),
        orderBy: (t, { asc: a }) => [a(t.serviceDate), a(t.id)],
      })
    : [order];

  const orderIds = siblingRows.map((o) => o.id);
  const publicIds = siblingRows.map((o) => o.publicId);

  const paymentRows = await db.query.payments.findMany({
    where: (t, { inArray: ia }) => ia(t.orderId, orderIds),
    orderBy: (t, { asc: a }) => [a(t.createdAt)],
  });

  const ledgerRows = await db.query.platformEventLedger.findMany({
    where: (t, { inArray: ia }) => ia(t.orderId, orderIds),
    orderBy: (t, { asc: a }) => [a(t.createdAt)],
  });

  const adminRows = await db.query.adminActionLog.findMany({
    where: (t, { and: a, eq: e, inArray: ia }) =>
      a(e(t.entityType, "order"), ia(t.entityId, orderIds.map(String))),
    orderBy: (t, { asc: a }) => [a(t.createdAt)],
  });

  const outboxRows = await listRelatedOutbox(db, {
    publicIds,
    checkoutId: order.checkoutId,
    orderIds,
  });

  const activity = [
    ...ledgerRows.map((r) => ({
      source: "ledger" as const,
      id: `led-${r.id}`,
      at: r.createdAt,
      orderId: r.orderId,
      eventName: r.eventName,
      channel: r.channel,
      actor: r.associatedMobile,
      payload: r.rawPayload,
    })),
    ...paymentRows.map((p) => ({
      source: "payment" as const,
      id: `pay-${p.id}`,
      at: p.createdAt,
      orderId: p.orderId,
      eventName: `PAYMENT_${p.kind}_${p.status}`,
      channel: "GATEWAY",
      actor: null as string | null,
      payload: {
        amountPaise: p.amountPaise,
        gatewayTxnId: p.gatewayTxnId,
        idempotencyKey: p.idempotencyKey,
        rawPayload: p.rawPayload,
      },
    })),
    ...adminRows.map((a) => ({
      source: "admin" as const,
      id: `adm-${a.id}`,
      at: a.createdAt,
      orderId: Number(a.entityId) || null,
      eventName: a.action,
      channel: "ADMIN",
      actor: a.actor,
      payload: { reason: a.reason, meta: a.payload },
    })),
    ...outboxRows.map((o) => ({
      source: "outbox" as const,
      id: `obx-${o.id}`,
      at: o.createdAt,
      orderId: null as number | null,
      eventName: `OUTBOX_${o.eventName}_${o.status.toUpperCase()}`,
      channel: "SYSTEM_CRON",
      actor: null as string | null,
      payload: {
        attempts: o.attempts,
        lastError: o.lastError,
        processedAt: o.processedAt,
        publicId: o.publicId,
        checkoutId: o.checkoutId,
        traceId: o.traceId,
      },
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const cloudLogging = {
    byTraceId: `jsonPayload.traceId="${order.traceId}"`,
    byPublicId: `jsonPayload.publicId="${order.publicId}"`,
    byCheckoutId: order.checkoutId
      ? `jsonPayload.checkoutId="${order.checkoutId}"`
      : null,
  };

  return {
    matchedBy,
    order: {
      id: order.id,
      publicId: order.publicId,
      checkoutId: order.checkoutId,
      traceId: order.traceId,
      status: order.status,
      customerMobile: order.customerMobile,
      payerMobile: order.payerMobile,
      mealType: order.mealType,
      serviceDate: order.serviceDate,
      itemName: order.itemName,
      qty: order.qty,
      spice: order.spice,
      foodPaise: order.foodPaise,
      foodDiscountPaise: order.foodDiscountPaise ?? 0,
      deliveryPaise: order.deliveryPaise,
      platformFeePaise: order.platformFeePaise,
      totalPaise: lineTotalPaise(order),
      gatewayTxnId: order.gatewayTxnId,
      channel: order.channel,
      fulfillmentMode: order.fulfillmentMode,
      deliveryTargetAddress: order.deliveryTargetAddress,
      settlementHold: order.settlementHold,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    },
    cook: cook
      ? {
          id: cook.id,
          kitchenName: cook.kitchenName,
          slugHandle: cook.slugHandle,
          mobileNumber: cook.mobileNumber,
        }
      : null,
    checkout: order.checkoutId
      ? {
          checkoutId: order.checkoutId,
          lines: siblingRows.map((o) => ({
            id: o.id,
            publicId: o.publicId,
            status: o.status,
            serviceDate: o.serviceDate,
            mealType: o.mealType,
            itemName: o.itemName,
            qty: o.qty,
            totalPaise: lineTotalPaise(o),
            traceId: o.traceId,
          })),
        }
      : null,
    payments: paymentRows.map((p) => ({
      id: p.id,
      orderId: p.orderId,
      kind: p.kind,
      status: p.status,
      amountPaise: p.amountPaise,
      gatewayTxnId: p.gatewayTxnId,
      createdAt: p.createdAt,
    })),
    outbox: outboxRows,
    cloudLogging,
    activity,
  };
}
