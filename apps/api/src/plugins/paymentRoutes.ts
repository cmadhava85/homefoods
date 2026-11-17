import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@localmeals/db";
import { LogEvent } from "@localmeals/observability";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";
import {
  classifyPaymentWebhook,
  getPaymentProvider,
  isMockPayments,
} from "@localmeals/adapters";
import { handlePaymentWebhook } from "../services/paymentWebhooks.js";
import {
  getOrderByPublicId,
  markOrderPaid,
} from "../services/orders.js";

export async function paymentRoutes(
  app: FastifyInstance,
  opts: { db: Db,
  auth: AuthHelpers },
) {
  const { db, auth } = opts;
  const { currentUser, assertAuthed, assertKitchenStaff, assertOrderKitchenStaff, bindCustomerMobile } = auth;
app.get("/webhooks/payments", async (_req, reply) => {
  if (process.env.NODE_ENV === "production") {
    return reply.code(404).send({ error: "Not found" });
  }
  return {
    ok: true,
    method: "POST",
    hint: "Razorpay webhooks must use POST with X-Razorpay-Signature",
  };
});

app.post(
  "/webhooks/payments",
  { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const provider = getPaymentProvider();
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
    ) as Record<string, string | undefined>;
    const rawBody = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    if (!provider.verifyWebhookSignature(headers, rawBody)) {
      req.log.warn(
        { event: LogEvent.WEBHOOK_SIGNATURE_FAILED, provider: "razorpay" },
        "payment webhook signature rejected",
      );
      return reply.code(401).send({ error: "Could not verify the request" });
    }
    try {
      const event = provider.parseWebhook?.(req.body) ?? classifyPaymentWebhook(req.body);
      const result = await handlePaymentWebhook(db, event);
      if (
        result &&
        typeof result === "object" &&
        "ignored" in result &&
        (result as { ignored?: boolean; reason?: string }).ignored &&
        (result as { reason?: string }).reason === "order_not_found"
      ) {
        req.log.warn(
          {
            event: LogEvent.WEBHOOK_HANDLER_FAILED,
            provider: "razorpay",
            reason: "order_not_found",
            gatewayTxnId: (result as { gatewayTxnId?: string }).gatewayTxnId,
          },
          "payment webhook: no matching order — acked so Razorpay stops retrying",
        );
      }
      return result;
    } catch (e) {
      req.log.error(
        { err: e, event: LogEvent.WEBHOOK_HANDLER_FAILED, provider: "razorpay" },
        "payment webhook handler failed",
      );
      return sendCaughtError(reply, e);
    }
  },
);

/** Mock helper: simulate UPI success from web pay page (disabled when MOCK_PAYMENTS=false) */
app.post("/payments/mock-confirm", async (req, reply) => {
  if (!isMockPayments()) {
    return reply.code(403).send({ error: "Mock pay is off — use the real UPI link" });
  }
  if (process.env.NODE_ENV === "production") {
    return reply.code(403).send({ error: "Mock pay is not available" });
  }
  const body = z.object({ gatewayTxnId: z.string().min(3) }).parse(req.body);
  if (!body.gatewayTxnId.startsWith("mock_")) {
    return reply.code(400).send({ error: "Mock confirm only accepts mock_ payment ids" });
  }
  const order = await markOrderPaid(db, {
    gatewayTxnId: body.gatewayTxnId,
    rawPayload: { mock: true },
  });
  return {
    ok: true,
    order,
    checkoutId: order.checkoutId ?? null,
    orders: order.orders ?? [order],
  };
});

/**
 * Return-URL confirm: after Razorpay redirects back, verify the payment link
 * with the gateway (never trust client linkStatus / paymentId alone).
 */
app.post("/payments/confirm-return", {
  config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
}, async (req, reply) => {
  const body = z
    .object({
      publicId: z.string().min(3),
      paymentLinkId: z.string().optional(),
      paymentId: z.string().optional(),
      linkStatus: z.string().optional(),
    })
    .parse(req.body);

  const isCheckout = body.publicId.startsWith("CHK-");
  let rows = isCheckout
    ? await db.query.orders.findMany({
        where: (t, { eq: e }) => e(t.checkoutId, body.publicId),
      })
    : [];
  if (!isCheckout) {
    const one = await getOrderByPublicId(db, body.publicId);
    if (one?.checkoutId) {
      rows = await db.query.orders.findMany({
        where: (t, { eq: e }) => e(t.checkoutId, one.checkoutId!),
      });
    } else if (one) {
      rows = [one];
    }
  }
  const seed = rows[0];
  if (!seed) return reply.code(404).send({ error: "Order not found" });

  const alreadyPaid = [
    "PAID",
    "COOKING",
    "PACKED",
    "DISPATCHED",
    "DELAYED",
    "DELIVERED",
  ].includes(seed.status);
  if (alreadyPaid) {
    return {
      ok: true,
      status: seed.status,
      checkoutId: seed.checkoutId ?? null,
      publicId: seed.publicId,
    };
  }

  const storedLink = seed.gatewayTxnId;
  if (!storedLink) {
    return reply.code(400).send({ error: "No payment link on order" });
  }
  // Never allow client to point confirmation at a different payment link.
  const plink = body.paymentLinkId ?? storedLink;
  if (plink !== storedLink) {
    return reply.code(400).send({ error: "Payment link does not match order" });
  }

  const provider = getPaymentProvider();
  if (!provider.getPaymentLinkStatus) {
    return reply.code(503).send({ error: "Payment verification unavailable" });
  }

  let live: { status: string; paymentId: string | null; amountPaise?: number };
  try {
    live = await provider.getPaymentLinkStatus(plink);
  } catch (e) {
    req.log.warn(e, "payment link status fetch failed");
    return {
      ok: false,
      pending: true,
      status: seed.status,
      linkStatus: null,
      checkoutId: seed.checkoutId ?? null,
      publicId: seed.publicId,
    };
  }

  const linkStatus = live.status.toLowerCase();
  const paymentId = live.paymentId ?? undefined;
  const paidLike = linkStatus === "paid" || linkStatus === "partially_paid";
  if (!paidLike) {
    return {
      ok: false,
      pending: true,
      status: seed.status,
      linkStatus,
      checkoutId: seed.checkoutId ?? null,
      publicId: seed.publicId,
    };
  }

  const expectedPaise = rows.reduce(
    (s, o) =>
      s +
      Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0)) +
      o.deliveryPaise +
      o.platformFeePaise,
    0,
  );
  // Live gateway: amount must be present and match. Mock may omit amountPaise.
  if (!isMockPayments()) {
    if (typeof live.amountPaise !== "number" || live.amountPaise <= 0) {
      return reply.code(409).send({ error: "Payment amount missing from gateway" });
    }
    if (live.amountPaise !== expectedPaise) {
      req.log.error(
        { expectedPaise, paidPaise: live.amountPaise, publicId: body.publicId },
        "confirm-return amount mismatch",
      );
      return reply.code(409).send({ error: "Payment amount does not match order" });
    }
  } else if (
    typeof live.amountPaise === "number" &&
    live.amountPaise > 0 &&
    live.amountPaise !== expectedPaise
  ) {
    return reply.code(409).send({ error: "Payment amount does not match order" });
  }

  try {
    const order = await markOrderPaid(db, {
      gatewayTxnId: seed.gatewayTxnId ?? plink,
      orderPublicId: body.publicId,
      paymentId,
      paidAmountPaise: live.amountPaise,
      rawPayload: {
        source: "confirm-return",
        paymentLinkId: plink,
        linkStatus,
        paymentId,
        amountPaise: live.amountPaise ?? null,
        expectedPaise,
      },
    });
    return {
      ok: true,
      status: order.status,
      checkoutId: order.checkoutId ?? null,
      publicId: order.publicId,
      orders: order.orders ?? [order],
    };
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});
}
