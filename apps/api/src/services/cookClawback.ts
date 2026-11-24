import { lineFoodNetPaise } from "@localmeals/domain";
import { and, asc, eq } from "drizzle-orm";
import { cookLedger, type Db } from "@localmeals/db";
import { getWhatsAppProvider } from "@localmeals/adapters";
import { enqueueOutbox } from "./outboxEnqueue.js";

export const CLAWBACK_PENDING = "CLAWBACK_PENDING";
export const CLAWBACK_APPLIED = "CLAWBACK_APPLIED";

function foodNetPaise(order: {
  foodPaise: number;
  qty: number;
  foodDiscountPaise?: number | null;
}) {
  return lineFoodNetPaise(order);
}

/** Pending recoveries still waiting for a future EOD with volume. */
export async function sumPendingClawbackPaise(db: Db, cookId: string): Promise<number> {
  const rows = await db.query.cookLedger.findMany({
    where: (t, { eq: e, and: a }) =>
      a(e(t.cookId, cookId), e(t.entryType, CLAWBACK_PENDING)),
  });
  return rows.reduce((n, r) => n + Math.max(0, r.amountPaise), 0);
}

export async function listPendingClawbacks(db: Db, cookId?: string) {
  const rows = await db.query.cookLedger.findMany({
    where: cookId
      ? (t, { eq: e, and: a }) => a(e(t.cookId, cookId), e(t.entryType, CLAWBACK_PENDING))
      : (t, { eq: e }) => e(t.entryType, CLAWBACK_PENDING),
    orderBy: (t, { asc: a }) => [a(t.id)],
    limit: 200,
  });
  return rows;
}

/**
 * After customer refund on a plate already included in a cook settlement,
 * queue food net for deduction on the cook's next EOD with volume.
 * Idempotent per order (one pending/applied clawback).
 */
export async function enqueueCookClawback(
  db: Db,
  input: {
    order: {
      id: number;
      publicId: string;
      cookId: string;
      settlementId: number | null;
      foodPaise: number;
      qty: number;
      foodDiscountPaise?: number | null;
    };
    reason: string;
    ticketId?: number;
  },
): Promise<{ created: boolean; amountPaise: number; entryId?: number }> {
  const { order } = input;
  if (!order.settlementId) {
    return { created: false, amountPaise: 0 };
  }

  const amountPaise = foodNetPaise(order);
  if (amountPaise <= 0) {
    return { created: false, amountPaise: 0 };
  }

  const existing = await db.query.cookLedger.findFirst({
    where: (t, { eq: e, and: a, inArray: ia }) =>
      a(
        e(t.orderId, order.id),
        ia(t.entryType, [CLAWBACK_PENDING, CLAWBACK_APPLIED]),
      ),
  });
  if (existing) {
    return { created: false, amountPaise: existing.amountPaise, entryId: existing.id };
  }

  const [entry] = await db
    .insert(cookLedger)
    .values({
      cookId: order.cookId,
      orderId: order.id,
      settlementId: null,
      entryType: CLAWBACK_PENDING,
      amountPaise,
      note: [
        `Recover food after refund · ${order.publicId}`,
        `prior settlement #${order.settlementId}`,
        input.ticketId ? `ticket #${input.ticketId}` : null,
        input.reason.slice(0, 120),
      ]
        .filter(Boolean)
        .join(" · "),
    })
    .returning();

  await enqueueOutbox(db, "CookClawbackPending", {
    cookId: order.cookId,
    orderId: order.id,
    publicId: order.publicId,
    amountPaise,
    ledgerId: entry.id,
    reason: input.reason.slice(0, 200),
  });

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, order.cookId),
  });
  if (cook?.mobileNumber) {
    try {
      await getWhatsAppProvider().send({
        to: cook.mobileNumber,
        body: [
          "⚠️ Payout recovery queued",
          `${order.publicId} · food ₹${(amountPaise / 100).toFixed(0)}`,
          "Customer was refunded after this plate was already settled to you.",
          "We will deduct it from your next EOD food payout (when you have delivered volume).",
          input.reason ? `Note: ${input.reason.slice(0, 120)}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      });
    } catch {
      /* WA best-effort */
    }
  }

  return { created: true, amountPaise, entryId: entry.id };
}

/**
 * Apply FIFO pending clawbacks up to `availablePaise` (today's food gross).
 * Returns paise actually applied against this settlement.
 */
export async function applyPendingClawbacksToSettlement(
  db: Db,
  input: { cookId: string; settlementId: number; availablePaise: number; businessDate: string },
): Promise<number> {
  const available = Math.max(0, input.availablePaise);
  if (available <= 0) return 0;

  const pending = await db
    .select()
    .from(cookLedger)
    .where(
      and(eq(cookLedger.cookId, input.cookId), eq(cookLedger.entryType, CLAWBACK_PENDING)),
    )
    .orderBy(asc(cookLedger.id));

  let left = available;
  let appliedTotal = 0;

  for (const row of pending) {
    if (left <= 0) break;
    const owe = Math.max(0, row.amountPaise);
    if (owe <= 0) continue;
    const take = Math.min(owe, left);

    await db.insert(cookLedger).values({
      cookId: input.cookId,
      orderId: row.orderId,
      settlementId: input.settlementId,
      entryType: CLAWBACK_APPLIED,
      amountPaise: take,
      note: `Applied on EOD ${input.businessDate} · from ledger #${row.id}`,
    });

    if (take >= owe) {
      await db.delete(cookLedger).where(eq(cookLedger.id, row.id));
    } else {
      await db
        .update(cookLedger)
        .set({ amountPaise: owe - take })
        .where(eq(cookLedger.id, row.id));
    }

    left -= take;
    appliedTotal += take;
  }

  return appliedTotal;
}
