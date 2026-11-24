import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import { orders, outbox, platformEventLedger, type Db } from "@localmeals/db";
import {
  addDaysISO,
  ORDER_STATES,
  serviceDateISO,
  type OrderState,
  lineTotalPaise,
} from "@localmeals/domain";

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

function tryNormalizeMobile(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  return null;
}

function adminOrderListRow(
  o: {
    id: number;
    publicId: string;
    checkoutId: string | null;
    status: string;
    customerMobile: string;
    payerMobile: string | null;
    serviceDate: string;
    mealType: string;
    itemName: string;
    qty: number;
    foodPaise: number;
    foodDiscountPaise: number | null;
    deliveryPaise: number;
    platformFeePaise: number;
    settlementHold: boolean;
    createdAt: Date;
    updatedAt: Date;
    cookId: string;
  },
  cookById: Map<string, { kitchenName: string; slugHandle: string }>,
) {
  const cook = cookById.get(o.cookId);
  return {
    id: o.id,
    publicId: o.publicId,
    checkoutId: o.checkoutId,
    status: o.status,
    customerMobile: o.customerMobile,
    payerMobile: o.payerMobile,
    serviceDate: o.serviceDate,
    mealType: o.mealType,
    itemName: o.itemName,
    qty: o.qty,
    totalPaise: lineTotalPaise(o),
    settlementHold: o.settlementHold,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    kitchenName: cook?.kitchenName ?? null,
    cookSlug: cook?.slugHandle ?? null,
  };
}

/**
 * Admin browse/search — mobile, cook slug, service date, status.
 * Newest first; max 100 rows.
 */
export async function searchAdminOrders(
  db: Db,
  opts: {
    mobile?: string;
    cookSlug?: string;
    serviceDate?: string;
    status?: string;
    limit?: number;
  },
) {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const clauses = [];

  if (opts.mobile?.trim()) {
    const mobile = tryNormalizeMobile(opts.mobile.trim());
    if (!mobile) throw new Error("Enter a valid Indian mobile number");
    clauses.push(
      or(eq(orders.customerMobile, mobile), eq(orders.payerMobile, mobile)),
    );
  }

  if (opts.cookSlug?.trim()) {
    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.slugHandle, opts.cookSlug!.trim()),
    });
    if (!cook) throw new Error("Kitchen not found");
    clauses.push(eq(orders.cookId, cook.id));
  }

  if (opts.serviceDate?.trim()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.serviceDate.trim())) {
      throw new Error("serviceDate must be YYYY-MM-DD");
    }
    clauses.push(eq(orders.serviceDate, opts.serviceDate.trim()));
  }

  if (opts.status?.trim()) {
    const status = opts.status.trim();
    if (!(ORDER_STATES as readonly string[]).includes(status)) {
      throw new Error("Unknown order status");
    }
    clauses.push(eq(orders.status, status as OrderState));
  }

  const rows = await db
    .select()
    .from(orders)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  const cookIds = [...new Set(rows.map((r) => r.cookId))];
  const cooks =
    cookIds.length === 0
      ? []
      : await db.query.cookProfiles.findMany({
          where: (t, { inArray: ia }) => ia(t.id, cookIds),
        });
  const cookById = new Map(cooks.map((c) => [c.id, c]));

  return {
    count: rows.length,
    orders: rows.map((o) => adminOrderListRow(o, cookById)),
  };
}

/**
 * Ops queue: cancel asks, payment stuck, logistics exceptions (recent window).
 */
export async function listAdminAttentionOrders(db: Db, limit = 40) {
  const capped = Math.min(Math.max(limit, 1), 80);
  const sinceDate = addDaysISO(serviceDateISO(), -2);
  const unpaidCutoff = new Date(Date.now() - 15 * 60 * 1000);

  const rows = await db
    .select()
    .from(orders)
    .where(
      and(
        gte(orders.serviceDate, sinceDate),
        or(
          eq(orders.status, "CANCEL_REQUESTED"),
          eq(orders.status, "CONFIRMING_PAYMENT"),
          eq(orders.status, "LOGISTICS_EXCEPTION"),
          and(eq(orders.status, "AWAITING_PAYMENT"), lt(orders.updatedAt, unpaidCutoff)),
        ),
      ),
    )
    .orderBy(desc(orders.updatedAt))
    .limit(capped);

  const cookIds = [...new Set(rows.map((r) => r.cookId))];
  const cooks =
    cookIds.length === 0
      ? []
      : await db.query.cookProfiles.findMany({
          where: (t, { inArray: ia }) => ia(t.id, cookIds),
        });
  const cookById = new Map(cooks.map((c) => [c.id, c]));

  return {
    count: rows.length,
    orders: rows.map((o) => {
      const row = adminOrderListRow(o, cookById);
      let reason = row.status;
      if (row.status === "AWAITING_PAYMENT") reason = "Unpaid hold >15m";
      if (row.status === "CONFIRMING_PAYMENT") reason = "Payment confirming stuck";
      if (row.status === "CANCEL_REQUESTED") reason = "Cancel ask";
      if (row.status === "LOGISTICS_EXCEPTION") reason = "Logistics exception";
      return { ...row, reason };
    }),
  };
}
