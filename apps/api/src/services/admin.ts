import { and, eq, sql } from "drizzle-orm";
import {
  adminActionLog,
  cookLedger,
  cookProfiles,
  orders,
  payments,
  settlements,
  supportTickets,
  type Db,
} from "@localmeals/db";
import { enqueueOutbox } from "./outboxEnqueue.js";
import { assertTransition, lineFoodNetPaise, lineTotalPaise, type OrderState } from "@localmeals/domain";
import { getPaymentProvider, getWhatsAppProvider, isMockPayments } from "@localmeals/adapters";
import { pauseCook } from "./cookOps.js";
import { currentRequestActor } from "../http/requestActor.js";

const OPEN_SETTLEMENT_STATUSES = [
  "AWAITING_MANUAL_PAY",
  "MISSING_PAYOUT_ACCOUNT",
  "TRANSFER_FAILED",
  "PENDING_TRANSFER",
  "TRANSFER_INITIATED",
] as const;

export async function listTickets(db: Db) {
  const rows = await db.query.supportTickets.findMany({
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  const now = Date.now();
  // OPEN tickets past SLA first, then newest.
  return [...rows].sort((a, b) => {
    const aBreached =
      a.status === "OPEN" && a.slaDueAt != null && a.slaDueAt.getTime() < now ? 1 : 0;
    const bBreached =
      b.status === "OPEN" && b.slaDueAt != null && b.slaDueAt.getTime() < now ? 1 : 0;
    if (aBreached !== bBreached) return bBreached - aBreached;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

export async function getTicket(db: Db, id: number) {
  const ticket = await db.query.supportTickets.findFirst({
    where: (t, { eq: e }) => e(t.id, id),
  });
  if (!ticket) return null;
  const order = ticket.orderId
    ? await db.query.orders.findFirst({
        where: (t, { eq: e }) => e(t.id, ticket.orderId!),
      })
    : null;
  const cook = ticket.cookId
    ? await db.query.cookProfiles.findFirst({
        where: (t, { eq: e }) => e(t.id, ticket.cookId!),
        columns: {
          id: true,
          kitchenName: true,
          slugHandle: true,
          mobileNumber: true,
          isActive: true,
          onboardingStatus: true,
        },
      })
    : null;
  return { ...ticket, order, cook };
}

/** Persist an admin/ops audit row (actor from ALS, or explicit job caller). */
export async function logAdmin(
  db: Db,
  action: string,
  entityType: string,
  entityId: string,
  reason?: string,
  payload?: object,
  actor?: string,
) {
  const who = (actor ?? currentRequestActor() ?? "owner").slice(0, 40);
  await db.insert(adminActionLog).values({
    actor: who,
    action,
    entityType,
    entityId,
    reason,
    payload,
  });
}

/** Public wrapper for route-level admin audit rows (EOD, outbox retry, …). */
export async function logAdminAction(
  db: Db,
  action: string,
  entityType: string,
  entityId: string,
  reason?: string,
  payload?: object,
  actor?: string,
) {
  return logAdmin(db, action, entityType, entityId, reason, payload, actor);
}

export async function holdSettlement(db: Db, orderId: number, reason: string) {
  const [updated] = await db
    .update(orders)
    .set({ settlementHold: true, updatedAt: new Date() })
    .where(eq(orders.id, orderId))
    .returning();
  await logAdmin(db, "HOLD_SETTLEMENT", "order", String(orderId), reason);
  return updated;
}

/** Week cart: CHARGE often sits on the first day-line; siblings share gatewayTxnId. */
async function resolveChargePayment(db: Db, order: typeof orders.$inferSelect) {
  const onOrder = await db.query.payments.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.orderId, order.id), e(t.kind, "CHARGE")),
  });
  if (onOrder) return onOrder;

  if (order.gatewayTxnId) {
    const byTxn = await db.query.payments.findFirst({
      where: (t, { eq: e, and: a }) =>
        a(e(t.gatewayTxnId, order.gatewayTxnId!), e(t.kind, "CHARGE")),
    });
    if (byTxn) return byTxn;
  }

  if (order.checkoutId) {
    const siblings = await db.query.orders.findMany({
      where: (t, { eq: e }) => e(t.checkoutId, order.checkoutId!),
      columns: { id: true },
    });
    for (const sib of siblings) {
      const row = await db.query.payments.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.orderId, sib.id), e(t.kind, "CHARGE")),
      });
      if (row) return row;
    }
  }
  return null;
}

export async function refundOrderByPublicId(
  db: Db,
  publicId: string,
  input: {
    mode: "FULL" | "FOOD_ONLY";
    reason: string;
    ticketId?: number;
  },
) {
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!order) throw new Error("Order not found");
  return refundOrder(db, { orderId: order.id, ...input });
}

/** A PENDING refund claim older than this is assumed orphaned (crash mid-refund) and re-claimable.
 * Keep in sync with `REFUND_CLAIM_STALE_MS` in orders.ts (paid-after-terminal auto-refund). */
const REFUND_CLAIM_STALE_MS = 10 * 60 * 1000;

function isAlreadyRefundedGatewayError(message: string) {
  return /fully refunded|already been refunded|refunded already/i.test(message);
}

export async function refundOrder(
  db: Db,
  input: {
    orderId: number;
    mode: "FULL" | "FOOD_ONLY";
    reason: string;
    ticketId?: number;
    /**
     * Customer-initiated cancel of one week-cart day: move the ₹7 fee to a remaining day and
     * claw back the week discount if the cart drops below minDays. Runs inside the claim txn,
     * only on the first claim, so retries can't apply it twice. Not used for admin/quality refunds.
     */
    rebalanceCheckout?: boolean;
    /** CREDIT = instant LocalMeals credit (no gateway call/fee). Credit-paid parts always return as credit. */
    refundTo?: "SOURCE" | "CREDIT";
  },
) {
  const pay = getPaymentProvider();
  const receipt = `lm_${input.orderId}_${input.mode}`;

  // Lock + claim first so concurrent admin/webhook refunds cannot double-refund.
  const claimed = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from orders where id = ${input.orderId} for update`);
    let order = await tx.query.orders.findFirst({
      where: (t, { eq: e }) => e(t.id, input.orderId),
    });
    if (!order) throw new Error("Order not found");
    if (order.status === "REFUNDED") {
      return { kind: "already" as const, order };
    }
    assertTransition(order.status as OrderState, "REFUNDED");

    const existingRefund = await tx.query.payments.findFirst({
      where: (t, { eq: e, and: a }) =>
        a(e(t.orderId, order!.id), e(t.kind, "REFUND"), e(t.idempotencyKey, receipt)),
    });

    if (!existingRefund && input.rebalanceCheckout) {
      const { rebalanceCheckoutForLineCancel } = await import("./orders.js");
      await rebalanceCheckoutForLineCancel(tx, order.id);
      order = (await tx.query.orders.findFirst({
        where: (t, { eq: e }) => e(t.id, input.orderId),
      }))!;
    }

    const amountPaise =
      input.mode === "FULL"
        ? lineTotalPaise(order)
        : lineFoodNetPaise(order);
    const toCredit =
      input.refundTo === "CREDIT"
        ? amountPaise
        : Math.min(amountPaise, order.creditAppliedPaise ?? 0);

    if (existingRefund) {
      const stalePending =
        existingRefund.status === "PENDING" &&
        Date.now() - new Date(existingRefund.createdAt).getTime() > REFUND_CLAIM_STALE_MS;
      if (existingRefund.status === "FAILED" || stalePending) {
        await tx
          .update(payments)
          .set({
            status: "PENDING",
            amountPaise,
            createdAt: new Date(),
            rawPayload: { mode: input.mode, reason: input.reason, retry: true },
          })
          .where(eq(payments.id, existingRefund.id));
        return { kind: "claimed" as const, order, amountPaise, toCredit };
      }
      // REFUNDED (finalize pending) or a fresh in-flight claim — don't call the gateway again.
      return { kind: "already" as const, order };
    }

    await tx.insert(payments).values({
      orderId: order.id,
      kind: "REFUND",
      amountPaise,
      status: "PENDING",
      gatewayTxnId: `pending_refund_${order.id}_${input.mode}`,
      rawPayload: { mode: input.mode, reason: input.reason, toCreditPaise: toCredit },
      idempotencyKey: receipt,
    });

    return { kind: "claimed" as const, order, amountPaise, toCredit };
  });

  if (claimed.kind === "already") return claimed.order;

  const { order, amountPaise, toCredit } = claimed;
  const gatewayPaise = amountPaise - toCredit;
  const charge = await resolveChargePayment(db, order);
  const chargePayload = (charge?.rawPayload ?? {}) as { razorpayPaymentId?: string };
  const paymentRef =
    chargePayload.razorpayPaymentId ||
    charge?.gatewayTxnId ||
    order.gatewayTxnId ||
    order.publicId;

  let gatewayRefund: Awaited<ReturnType<typeof pay.refundPayment>> | null = null;
  let alreadyRefundedAtGateway = false;
  try {
    if (gatewayPaise > 0) gatewayRefund = await pay.refundPayment({
      paymentId: paymentRef,
      amountPaise: gatewayPaise,
      receipt,
      notes: {
        orderPublicId: order.publicId,
        mode: input.mode,
        reason: input.reason.slice(0, 100),
        ...(order.traceId ? { traceId: order.traceId.slice(0, 40) } : {}),
      },
    });
  } catch (e) {
    const message = (e as Error).message;
    // A re-claimed (stale) refund whose first gateway call actually succeeded — finalize, don't fail.
    if (isAlreadyRefundedGatewayError(message)) {
      alreadyRefundedAtGateway = true;
    } else if (!isMockPayments()) {
      await db
        .update(payments)
        .set({
          status: "FAILED",
          rawPayload: {
            mode: input.mode,
            reason: input.reason,
            paymentRef,
            error: message,
          },
        })
        .where(and(eq(payments.orderId, order.id), eq(payments.idempotencyKey, receipt)));
      throw new Error(`Razorpay refund failed: ${message}`);
    }
  }

  const gatewayStatus = alreadyRefundedAtGateway || gatewayPaise === 0
    ? "processed"
    : (gatewayRefund?.status ?? (gatewayRefund ? "unknown" : "PENDING"));
  const paymentStatus =
    gatewayStatus === "processed" || gatewayStatus === "completed"
      ? "REFUNDED"
      : gatewayRefund
        ? "PENDING"
        : "PENDING";

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(orders)
      .set({
        status: "REFUNDED",
        settlementHold: true,
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, order.id), sql`${orders.status} <> 'REFUNDED'`))
      .returning();

    await tx
      .update(payments)
      .set({
        status: paymentStatus,
        gatewayTxnId: gatewayRefund?.refundId ?? `refund_${order.gatewayTxnId ?? order.publicId}`,
        rawPayload: {
          mode: input.mode,
          reason: input.reason,
          gateway: gatewayRefund,
          paymentRef,
          gatewayStatus,
          toCreditPaise: toCredit,
          gatewayPaise,
        },
      })
      .where(and(eq(payments.orderId, order.id), eq(payments.idempotencyKey, receipt)));

    if (toCredit > 0) {
      const { addCredit } = await import("./credits.js");
      await addCredit(tx, {
        mobile: order.customerMobile,
        amountPaise: toCredit,
        reason: input.refundTo === "CREDIT" ? "REFUND_TO_CREDIT" : "REFUND_CREDIT_PART",
        orderId: order.id,
        key: `refund_${receipt}`,
      });
    }

    if (input.ticketId) {
      await tx
        .update(supportTickets)
        .set({
          status: "RESOLVED",
          decision: input.mode === "FULL" ? "FULL_REFUND" : "PARTIAL_REFUND",
          resolvedAt: new Date(),
        })
        .where(eq(supportTickets.id, input.ticketId));
    }

    await enqueueOutbox(tx, "OrderRefunded", {
      orderId: order.id,
      publicId: order.publicId,
      customerMobile: order.customerMobile,
      mode: input.mode,
      refundId: gatewayRefund?.refundId ?? null,
      source: "admin",
      reason: input.reason,
      amountPaise,
      creditPaise: toCredit,
    });

    return row ?? order;
  });

  await logAdmin(db, `REFUND_${input.mode}`, "order", String(order.id), input.reason, {
    ticketId: input.ticketId,
  });

  const { recordOrderActivity } = await import("./orderActivity.js");
  await recordOrderActivity(db, {
    orderId: order.id,
    customerMobile: order.customerMobile,
    cookId: order.cookId,
    channel: input.ticketId != null || /admin/i.test(input.reason) ? "ADMIN" : "SYSTEM_CRON",
    eventName: "ORDER_REFUNDED",
    payload: {
      mode: input.mode,
      reason: input.reason,
      amountPaise,
      refundId: gatewayRefund?.refundId ?? null,
      paymentRef,
      ticketId: input.ticketId ?? null,
      fromStatus: order.status,
      gatewayStatus,
    },
  });

  const { enqueueCookClawback } = await import("./cookClawback.js");
  const clawback = await enqueueCookClawback(db, {
    order: updated,
    reason: input.reason,
    ticketId: input.ticketId,
  });

  return { ...updated, clawback };
}

export async function adminPauseCook(db: Db, cookId: string, reason: string) {
  const updated = await pauseCook(db, cookId, reason);
  await logAdmin(db, "PAUSE_COOK", "cook", cookId, reason);
  return updated;
}

export async function listCooks(db: Db) {
  const { listCooksForAdmin } = await import("./cookApply.js");
  return listCooksForAdmin(db);
}

export async function adminApproveCook(db: Db, cookId: string) {
  const { adminApproveCookLive } = await import("./cookApply.js");
  const updated = await adminApproveCookLive(db, cookId);
  await logAdmin(db, "APPROVE_COOK_LIVE", "cook", cookId);
  return updated;
}

export async function adminSetCookPayoutDetails(
  db: Db,
  cookId: string,
  input: {
    payoutUpiId?: string | null;
    payoutAccountNote?: string | null;
    payoutBeneficiaryRef?: string | null;
    pickupLandmark?: string | null;
    pickupEnabled?: boolean;
    deliveryType?: "SELF" | "PARTNER";
  },
) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, cookId),
  });
  if (!cook) throw new Error("Cook not found");

  const patch: {
    payoutUpiId?: string | null;
    payoutAccountNote?: string | null;
    payoutBeneficiaryRef?: string | null;
    pickupLandmark?: string | null;
    pickupEnabled?: boolean;
    deliveryType?: "SELF" | "PARTNER";
  } = {};

  if (input.payoutUpiId !== undefined) {
    patch.payoutUpiId = input.payoutUpiId?.trim() || null;
  }
  if (input.payoutAccountNote !== undefined) {
    patch.payoutAccountNote = input.payoutAccountNote?.trim() || null;
  }
  if (input.payoutBeneficiaryRef !== undefined) {
    const trimmed = input.payoutBeneficiaryRef?.trim() || null;
    if (trimmed && !trimmed.startsWith("acc_") && !trimmed.startsWith("rzp_acc_")) {
      throw new Error("Payout account must be a Razorpay linked account id (acc_…)");
    }
    patch.payoutBeneficiaryRef = trimmed;
  }
  if (input.pickupLandmark !== undefined) {
    patch.pickupLandmark = input.pickupLandmark?.trim() || null;
  }
  if (input.pickupEnabled !== undefined) {
    patch.pickupEnabled = Boolean(input.pickupEnabled);
  }
  if (input.deliveryType !== undefined) {
    patch.deliveryType = input.deliveryType;
  }

  const [updated] = await db
    .update(cookProfiles)
    .set(patch)
    .where(eq(cookProfiles.id, cookId))
    .returning();

  await logAdmin(db, "SET_PAYOUT_DETAILS", "cook", cookId, undefined, {
    ...patch,
    previous: {
      payoutUpiId: cook.payoutUpiId,
      payoutAccountNote: cook.payoutAccountNote,
      payoutBeneficiaryRef: cook.payoutBeneficiaryRef,
    },
  });

  return updated;
}

/** Settlements for ops: open = needs manual (or failed) pay; all = history. */
export async function listSettlementsForAdmin(
  db: Db,
  opts: { filter?: "open" | "all"; limit?: number } = {},
) {
  const filter = opts.filter ?? "open";
  const limit = opts.limit ?? 80;
  const rows = await db.query.settlements.findMany({
    orderBy: (t, { desc: d }) => [d(t.businessDate), d(t.id)],
    limit: filter === "open" ? 200 : limit,
  });

  const filtered =
    filter === "open"
      ? rows
          .filter(
            (s) =>
              !s.manualPaidAt &&
              s.status !== "MANUAL_PAID" &&
              (OPEN_SETTLEMENT_STATUSES as readonly string[]).includes(s.status),
          )
          .slice(0, limit)
      : rows.slice(0, limit);

  const cookIds = [...new Set(filtered.map((s) => s.cookId))];
  const cooks = cookIds.length
    ? await db.query.cookProfiles.findMany({
        where: (t, { inArray: ia }) => ia(t.id, cookIds),
      })
    : [];
  const byCook = new Map(cooks.map((c) => [c.id, c]));

  const { CLAWBACK_PENDING } = await import("./cookClawback.js");
  const pendingRows = cookIds.length
    ? await db.query.cookLedger.findMany({
        where: (t, { inArray: ia, and: a, eq: e }) =>
          a(ia(t.cookId, cookIds), e(t.entryType, CLAWBACK_PENDING)),
      })
    : [];
  const pendingByCook = new Map<string, number>();
  for (const row of pendingRows) {
    pendingByCook.set(row.cookId, (pendingByCook.get(row.cookId) ?? 0) + row.amountPaise);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return filtered.map((s) => {
    const cook = byCook.get(s.cookId);
    const needsManualPay =
      !s.manualPaidAt &&
      s.status !== "MANUAL_PAID" &&
      (OPEN_SETTLEMENT_STATUSES as readonly string[]).includes(s.status);
    const biz = new Date(`${s.businessDate}T00:00:00`);
    const ageDays = Math.max(
      0,
      Math.floor((today.getTime() - biz.getTime()) / (24 * 60 * 60 * 1000)),
    );
    return {
      id: s.id,
      businessDate: s.businessDate,
      cookId: s.cookId,
      kitchenName: cook?.kitchenName ?? "Kitchen",
      cookSlug: cook?.slugHandle ?? null,
      cookMobile: cook?.mobileNumber ?? null,
      payoutUpiId: cook?.payoutUpiId ?? null,
      payoutAccountNote: cook?.payoutAccountNote ?? null,
      payoutBeneficiaryRef: cook?.payoutBeneficiaryRef ?? null,
      grossPaise: s.grossPaise,
      feesPaise: s.feesPaise,
      clawbackPaise: s.clawbackPaise ?? 0,
      pendingClawbackPaise: pendingByCook.get(s.cookId) ?? 0,
      netPaise: s.netPaise,
      orderCount: s.orderCount,
      status: s.status,
      gatewayBatchId: s.gatewayBatchId,
      manualPaidAt: s.manualPaidAt,
      manualUtr: s.manualUtr,
      manualNote: s.manualNote,
      needsManualPay,
      ageDays,
      overdue: needsManualPay && ageDays >= 1,
      createdAt: s.createdAt,
    };
  });
}

export async function adminMarkSettlementManualPaid(
  db: Db,
  settlementId: number,
  input: { utr: string; note?: string },
) {
  const settlement = await db.query.settlements.findFirst({
    where: (t, { eq: e }) => e(t.id, settlementId),
  });
  if (!settlement) throw new Error("Settlement not found");
  if (settlement.manualPaidAt || settlement.status === "MANUAL_PAID") {
    return settlement;
  }
  if (settlement.status === "COMPLETED" && settlement.gatewayBatchId?.startsWith("trf_")) {
    throw new Error("Already settled via Razorpay Route — no manual mark needed");
  }

  const utr = input.utr.trim();
  if (utr.length < 4) throw new Error("Enter UTR / UPI reference (min 4 characters)");

  const paidAt = new Date();
  const [updated] = await db
    .update(settlements)
    .set({
      status: "MANUAL_PAID",
      manualPaidAt: paidAt,
      manualUtr: utr.slice(0, 80),
      manualNote: input.note?.trim() || null,
      gatewayBatchId: settlement.gatewayBatchId || `manual_${utr.slice(0, 40)}`,
    })
    .where(eq(settlements.id, settlementId))
    .returning();

  await db.insert(cookLedger).values({
    cookId: settlement.cookId,
    settlementId: settlement.id,
    entryType: "MANUAL_PAYOUT",
    amountPaise: settlement.netPaise,
    note: [
      `Manual payout · ${settlement.businessDate}`,
      `UTR ${utr}`,
      input.note?.trim() || null,
    ]
      .filter(Boolean)
      .join(" · "),
  });

  await logAdmin(db, "MANUAL_SETTLEMENT_PAID", "settlement", String(settlementId), input.note, {
    utr,
    netPaise: settlement.netPaise,
    cookId: settlement.cookId,
    businessDate: settlement.businessDate,
  });

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, settlement.cookId),
  });
  if (cook) {
    await getWhatsAppProvider().send({
      to: cook.mobileNumber,
      body: `Settlement paid · ${settlement.businessDate}: ₹${(settlement.netPaise / 100).toFixed(2)} for ${settlement.orderCount} order(s). Ref ${utr}`,
    });
  }

  return updated;
}

const TICKET_CATEGORIES = [
  "MISSING_DELIVERY",
  "QUALITY",
  "WRONG_ITEM",
  "PAYMENT",
  "FOODBORNE",
  "COOK_OPS",
  "DELAY",
  "DOOR_NO_ANSWER",
  "OTHER",
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export async function createTicketFromHelp(
  db: Db,
  input: {
    customerMobile?: string | null;
    orderPublicId?: string;
    summary: string;
    category?: TicketCategory;
    source?: string;
    photoUrl?: string | null;
    /** When reporting without an order (e.g. cook desk). */
    cookId?: string | null;
  },
) {
  let orderId: number | undefined;
  let cookId: string | undefined = input.cookId ?? undefined;
  let orderPublicId = input.orderPublicId;
  if (input.orderPublicId) {
    const order = await db.query.orders.findFirst({
      where: (t, { eq: e }) => e(t.publicId, input.orderPublicId!),
    });
    orderId = order?.id;
    cookId = cookId ?? order?.cookId;
    orderPublicId = order?.publicId ?? orderPublicId;
  }
  const photoUrl =
    input.photoUrl && /^\/uploads\/concern-[a-zA-Z0-9._-]+$/.test(input.photoUrl)
      ? input.photoUrl
      : null;
  const [ticket] = await db
    .insert(supportTickets)
    .values({
      orderId,
      cookId,
      customerMobile: input.customerMobile ?? null,
      category: input.category ?? "OTHER",
      summary: input.summary,
      source: input.source ?? "WHATSAPP",
      photoUrl,
      slaDueAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    })
    .returning();

  await enqueueOutbox(db, "TicketCreated", {
    ticketId: ticket.id,
    category: ticket.category,
    orderPublicId: orderPublicId ?? null,
    orderId: orderId ?? null,
    cookId: cookId ?? null,
    customerMobile: ticket.customerMobile,
    source: ticket.source,
    summary: ticket.summary.slice(0, 240),
    slaDueAt: ticket.slaDueAt?.toISOString() ?? null,
  });

  return ticket;
}

/**
 * Cook desk "Report an issue" → support ticket (source COOK).
 */
export async function createCookTicket(
  db: Db,
  input: {
    cookId: string;
    cookMobile: string;
    summary: string;
    category?: TicketCategory;
    orderPublicId?: string | null;
  },
) {
  const summary = input.summary.trim();
  if (summary.length < 10) {
    throw new Error("Please describe the issue (at least a short sentence)");
  }
  if (summary.length > 2000) {
    throw new Error("Issue is too long");
  }
  const category = input.category ?? "COOK_OPS";
  if (!TICKET_CATEGORIES.includes(category)) {
    throw new Error("Invalid category");
  }

  const ticket = await createTicketFromHelp(db, {
    customerMobile: input.cookMobile,
    cookId: input.cookId,
    orderPublicId: input.orderPublicId ?? undefined,
    summary: `[COOK] ${summary}`,
    category,
    source: "COOK",
  });

  await logAdmin(db, "COOK_TICKET", "ticket", String(ticket.id), summary, {
    cookId: input.cookId,
    orderPublicId: input.orderPublicId ?? null,
    category,
  });

  return ticket;
}

const CONCERN_OK_STATUSES = new Set([
  "PAID",
  "COOKING",
  "PACKED",
  "DISPATCHED",
  "DELIVERED",
  "DELAYED",
  "RETURNED_TO_KITCHEN",
  "LOGISTICS_EXCEPTION",
  "REFUNDED",
]);

/**
 * Customer web concern on a specific order → support ticket for Admin.
 */
export async function createOrderConcern(
  db: Db,
  input: {
    customerMobile: string;
    orderPublicId: string;
    category: TicketCategory;
    summary: string;
    photoUrl?: string | null;
  },
) {
  const summary = input.summary.trim();
  if (summary.length < 10) {
    throw new Error("Please describe the issue (at least a short sentence)");
  }
  if (summary.length > 2000) {
    throw new Error("Concern is too long");
  }
  if (!TICKET_CATEGORIES.includes(input.category)) {
    throw new Error("Invalid concern category");
  }

  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, input.orderPublicId),
  });
  if (!order) throw new Error("Order not found");
  if (order.customerMobile !== input.customerMobile) {
    throw new Error("Not your order");
  }
  if (!CONCERN_OK_STATUSES.has(order.status)) {
    throw new Error("You can raise a concern after the order is paid");
  }

  const open = await db.query.supportTickets.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.orderId, order.id), e(t.status, "OPEN"), e(t.customerMobile, input.customerMobile)),
  });
  if (open) {
    throw new Error(`You already have open ticket #${open.id} for this order`);
  }

  const ticket = await createTicketFromHelp(db, {
    customerMobile: input.customerMobile,
    orderPublicId: order.publicId,
    summary: `[${input.category}] ${summary}`,
    category: input.category,
    source: "WEB",
    photoUrl: input.photoUrl,
  });

  await logAdmin(db, "CUSTOMER_CONCERN", "ticket", String(ticket.id), summary, {
    orderPublicId: order.publicId,
    category: input.category,
    customerMobile: input.customerMobile,
    photoUrl: ticket.photoUrl,
  });

  // Cook heads-up (ops still owns refund / hold)
  if (order.cookId) {
    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.id, order.cookId),
    });
    if (cook?.mobileNumber) {
      try {
        await getWhatsAppProvider().send({
          to: cook.mobileNumber,
          body: [
            `Customer concern · ${order.publicId}`,
            `Type: ${input.category}`,
            ticket.photoUrl ? "Photo attached for ops." : null,
            "LocalMeals ops will review — may refund and/or hold this order’s payout.",
          ]
            .filter(Boolean)
            .join("\n"),
        });
      } catch (err) {
        console.warn("[concern] cook WA notify failed", err);
      }
    }
  }

  return {
    ok: true as const,
    ticketId: ticket.id,
    category: ticket.category,
    status: ticket.status,
    photoUrl: ticket.photoUrl,
    message: `Ticket #${ticket.id} created. Our ops team will review.`,
  };
}

export async function adminUpdateTicket(
  db: Db,
  ticketId: number,
  input: { category?: TicketCategory; status?: "OPEN" | "RESOLVED" | "CLOSED" },
) {
  const ticket = await db.query.supportTickets.findFirst({
    where: (t, { eq: e }) => e(t.id, ticketId),
  });
  if (!ticket) throw new Error("Ticket not found");

  const patch: {
    category?: TicketCategory;
    status?: "OPEN" | "RESOLVED" | "CLOSED";
    resolvedAt?: Date | null;
  } = {};
  if (input.category) {
    if (!TICKET_CATEGORIES.includes(input.category)) {
      throw new Error("Invalid category");
    }
    patch.category = input.category;
  }
  if (input.status) {
    patch.status = input.status;
    patch.resolvedAt =
      input.status === "RESOLVED" || input.status === "CLOSED" ? new Date() : null;
  }
  if (!Object.keys(patch).length) throw new Error("Nothing to update");

  const [updated] = await db
    .update(supportTickets)
    .set(patch)
    .where(eq(supportTickets.id, ticketId))
    .returning();

  await logAdmin(db, "UPDATE_TICKET", "ticket", String(ticketId), undefined, {
    ...patch,
    previous: { category: ticket.category, status: ticket.status },
  });
  return updated;
}
