import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import { Count, OrderStatus, Text, Uuid } from "../openapi/shared.js";
import { JsonObject, OrderRow, PaidOrder, SettlementRow } from "./adminShared.contract.js";

/**
 * Razorpay webhook envelope (documentation — the handler verifies X-Razorpay-Signature over the RAW
 * body and classifies events itself). Captures: payment_link.paid, payment.captured, qr_code.credited.
 */
export const RazorpayWebhookBody = z
  .object({
    entity: z.string().max(20).optional(),
    account_id: z.string().max(40).optional(),
    event: z.string().max(100).describe("e.g. payment_link.paid, qr_code.credited, refund.processed"),
    contains: z.array(z.string().max(40)).max(10).optional(),
    payload: JsonObject.describe("Entities keyed by type: payment, payment_link, qr_code, refund, transfer, …"),
    created_at: z.number().int().min(0).max(10_000_000_000).optional(),
  })
  .describe("Razorpay webhook event");

export const MockConfirmBody = z
  .object({ gatewayTxnId: z.string().min(3).max(100).describe("mock_… payment id") })
  .describe("Simulate a successful UPI payment (non-production mocks only)");

export const ConfirmReturnBody = z
  .object({
    publicId: z.string().min(3).max(20).describe("LM-… or CHK-…"),
    paymentLinkId: z.string().max(100).optional(),
    paymentId: z.string().max(100).optional(),
    linkStatus: z.string().max(30).optional().describe("Ignored — status is re-fetched from the gateway"),
  })
  .describe("Razorpay return-URL confirmation");

const WebhookResult = z
  .object({
    ok: z.literal(true),
    kind: z.string().max(40),
    event: z.string().max(100).optional(),
    matched: Count.optional(),
    orders: z.array(OrderRow).max(42).optional(),
    order: PaidOrder.optional(),
    traceId: Text(40).optional(),
    status: z.string().max(40).nullable().optional(),
    settlement: SettlementRow.optional(),
    cookId: Uuid.nullable().optional(),
    utr: z.string().max(60).nullable().optional(),
    ignored: z.literal(true).optional(),
    reason: z.string().max(60).optional(),
    gatewayTxnId: z.string().max(100).nullable().optional(),
    orderPublicId: z.string().max(40).nullable().optional(),
  })
  .describe("Acknowledgement (unknown orders are acked so Razorpay stops retrying)");

const ConfirmResult = z.object({
  ok: z.boolean(),
  pending: z.literal(true).optional(),
  status: OrderStatus,
  linkStatus: z.string().max(30).nullable().optional(),
  checkoutId: Text(20).nullable(),
  publicId: Text(20),
  orders: z.array(OrderRow).max(42).optional(),
});

export const paymentOperations = defineOperations([
  {
    method: "get",
    path: "/webhooks/payments",
    operationId: "paymentWebhookHint",
    summary: "Non-production hint (404 in production); Razorpay delivers via POST",
    tags: ["Webhooks"],
    access: "public",
    response: z.object({ ok: z.literal(true), method: z.literal("POST"), hint: Text(200) }),
    errors: { 404: "Production" },
  },
  {
    method: "post",
    path: "/webhooks/payments",
    operationId: "razorpayWebhook",
    summary: "Razorpay webhook (HMAC X-Razorpay-Signature over the raw body)",
    tags: ["Webhooks"],
    access: "webhook:razorpay",
    body: RazorpayWebhookBody,
    response: WebhookResult,
  },
  {
    method: "post",
    path: "/payments/mock-confirm",
    operationId: "mockConfirmPayment",
    summary: "Local/staging mocks only: mark a mock_ payment as captured (403 otherwise)",
    tags: ["Payments"],
    access: "public",
    body: MockConfirmBody,
    response: z.object({
      ok: z.literal(true),
      order: PaidOrder,
      checkoutId: Text(20).nullable(),
      orders: z.array(OrderRow).max(42),
    }),
  },
  {
    method: "post",
    path: "/payments/confirm-return",
    operationId: "confirmPaymentReturn",
    summary:
      "After Razorpay redirects back: re-verify the payment link with the gateway and mark paid (amount must equal the gateway charge)",
    tags: ["Payments"],
    access: "public",
    body: ConfirmReturnBody,
    response: ConfirmResult,
    errors: { 404: "Order not found", 409: "Amount mismatch / missing", 503: "Verification unavailable" },
  },
]);

