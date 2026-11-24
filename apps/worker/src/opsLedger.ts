import { and, eq, gte, sql } from "drizzle-orm";
import { orders, platformEventLedger, type Db } from "@localmeals/db";

/** Tie a failed/skipped outbox notify to the order activity timeline. */
export async function recordOutboxOpsFailure(
  db: Db,
  input: {
    eventName: string;
    payload: Record<string, unknown>;
    reason: string;
    lastError?: string | null;
    attempts?: number;
  },
) {
  const publicId =
    (typeof input.payload.publicId === "string" && input.payload.publicId) ||
    (typeof input.payload.orderPublicId === "string" && input.payload.orderPublicId) ||
    null;
  const checkoutId =
    typeof input.payload.checkoutId === "string" ? input.payload.checkoutId : null;
  let orderId =
    typeof input.payload.orderId === "number"
      ? input.payload.orderId
      : typeof input.payload.orderId === "string" && /^\d+$/.test(input.payload.orderId)
        ? Number(input.payload.orderId)
        : null;

  let customerMobile: string | null =
    typeof input.payload.customerMobile === "string"
      ? input.payload.customerMobile
      : typeof input.payload.seniorMobile === "string"
        ? input.payload.seniorMobile
        : null;
  let cookId: string | null =
    typeof input.payload.cookId === "string" ? input.payload.cookId : null;

  if (!orderId && publicId) {
    const [row] = await db
      .select({
        id: orders.id,
        customerMobile: orders.customerMobile,
        cookId: orders.cookId,
      })
      .from(orders)
      .where(eq(orders.publicId, publicId))
      .limit(1);
    if (row) {
      orderId = row.id;
      customerMobile = customerMobile ?? row.customerMobile;
      cookId = cookId ?? row.cookId;
    }
  }
  if (!orderId && checkoutId) {
    const [row] = await db
      .select({
        id: orders.id,
        customerMobile: orders.customerMobile,
        cookId: orders.cookId,
      })
      .from(orders)
      .where(eq(orders.checkoutId, checkoutId))
      .limit(1);
    if (row) {
      orderId = row.id;
      customerMobile = customerMobile ?? row.customerMobile;
      cookId = cookId ?? row.cookId;
    }
  }
  if (!orderId) return false;

  await db.insert(platformEventLedger).values({
    associatedMobile: customerMobile,
    orderId,
    cookId,
    channel: "SYSTEM_CRON",
    eventName: "OUTBOX_NOTIFY_FAILED",
    rawPayload: {
      outboxEvent: input.eventName,
      reason: input.reason,
      lastError: input.lastError ?? null,
      attempts: input.attempts ?? null,
      publicId,
      checkoutId,
    },
  });
  return true;
}

/** Deduped (6h) ledger mark for CONFIRMING_PAYMENT stuck orders. */
export async function recordConfirmingStuckOnce(
  db: Db,
  input: {
    orderId: number;
    publicId: string;
    customerMobile?: string | null;
    cookId?: string | null;
    stuckMs: number;
  },
) {
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const [existing] = await db
    .select({ id: platformEventLedger.id })
    .from(platformEventLedger)
    .where(
      and(
        eq(platformEventLedger.orderId, input.orderId),
        eq(platformEventLedger.eventName, "PAYMENT_CONFIRMING_STUCK"),
        gte(platformEventLedger.createdAt, since),
      ),
    )
    .limit(1);
  if (existing) return false;

  await db.insert(platformEventLedger).values({
    associatedMobile: input.customerMobile ?? null,
    orderId: input.orderId,
    cookId: input.cookId ?? null,
    channel: "SYSTEM_CRON",
    eventName: "PAYMENT_CONFIRMING_STUCK",
    rawPayload: { publicId: input.publicId, stuckMs: input.stuckMs },
  });
  return true;
}

/** Log ticket.sla_breached once per ticket (deduped via platform_event_ledger). */
export async function recordTicketSlaBreachedOnce(
  db: Db,
  input: {
    ticketId: number;
    orderId?: number | null;
    cookId?: string | null;
    customerMobile?: string | null;
    slaDueAt?: string | null;
  },
) {
  const [existing] = await db
    .select({ id: platformEventLedger.id })
    .from(platformEventLedger)
    .where(
      and(
        eq(platformEventLedger.eventName, "TICKET_SLA_BREACHED"),
        sql`${platformEventLedger.rawPayload}->>'ticketId' = ${String(input.ticketId)}`,
      ),
    )
    .limit(1);
  if (existing) return false;

  await db.insert(platformEventLedger).values({
    associatedMobile: input.customerMobile ?? null,
    orderId: input.orderId ?? null,
    cookId: input.cookId ?? null,
    channel: "SYSTEM_CRON",
    eventName: "TICKET_SLA_BREACHED",
    rawPayload: {
      ticketId: input.ticketId,
      slaDueAt: input.slaDueAt ?? null,
    },
  });
  return true;
}
