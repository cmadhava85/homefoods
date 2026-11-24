import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import { Count, Id, Text } from "../openapi/shared.js";
import { JsonObject } from "./adminShared.contract.js";

export const WhatsAppVerifyQuery = z.object({
  "hub.mode": z.string().max(20).optional(),
  "hub.verify_token": z.string().max(200).optional(),
  "hub.challenge": z.string().max(200).optional(),
});

/**
 * Meta Cloud API envelope ({object, entry[].changes[].value.messages[]}) or the local simulator
 * shape ({from, text, locale?}). Signature (X-Hub-Signature-256) is verified over the raw body.
 */
export const WhatsAppWebhookBody = z
  .object({
    object: z.string().max(40).optional(),
    entry: z.array(JsonObject).max(20).optional(),
    from: z.string().max(20).optional().describe("Simulator: sender mobile"),
    text: z.string().max(4096).optional().describe("Simulator: message text"),
    locale: z.string().max(5).optional(),
  })
  .describe("Meta webhook envelope or local simulator message");

const Flag = z.boolean().optional();

const WhatsAppResult = z
  .object({
    ok: z.boolean(),
    intent: z.string().max(40).optional(),
    replies: z
      .array(z.object({ body: z.string().max(4096), buttons: z.array(z.string().max(40)).max(10).optional() }))
      .max(20)
      .optional(),
    duplicate: Flag,
    ignored: Flag,
    publicId: Text(20).optional(),
    checkoutId: Text(20).optional(),
    gatewayTxnId: z.string().max(100).nullable().optional(),
    paymentUrl: z.string().max(500).optional(),
    ticketId: Id.optional(),
    reviewId: Id.optional(),
    addressId: Id.optional(),
    count: Count.optional(),
    status: z.string().max(40).optional(),
    slug: z.string().max(50).optional(),
    mealType: z.string().max(10).optional(),
    locale: z.string().max(5).optional(),
    error: z.string().max(500).optional(),
    empty: Flag,
    nothing: Flag,
    skipped: Flag,
    unhandled: Flag,
    optedOut: Flag,
    cancelAccepted: Flag,
    cancelDeclined: Flag,
    pickAddress: Flag,
    pickMeal: Flag,
    needAddFirst: Flag,
    needArgs: Flag,
    needImage: Flag,
    needItem: Flag,
    needLang: Flag,
    needMobile: Flag,
    needParse: Flag,
    needPublicId: Flag,
    needSlug: Flag,
  })
  .describe("Handler outcome (Meta ignores the body; the simulator renders `replies`)");

export const whatsappOperations = defineOperations([
  {
    method: "get",
    path: "/webhooks/whatsapp",
    operationId: "whatsappWebhookVerify",
    summary: "Meta webhook verification — echoes hub.challenge when hub.verify_token matches (403 otherwise)",
    tags: ["Webhooks"],
    access: "public",
    query: WhatsAppVerifyQuery,
    credentialQueryJustification:
      "Meta's webhook subscription handshake sends hub.verify_token as a query parameter; it is a shared verification string, not a session credential, and inbound events are separately HMAC-verified.",
    responseContentType: "text/plain",
    response: z.string().max(200),
  },
  {
    method: "post",
    path: "/webhooks/whatsapp",
    operationId: "whatsappWebhook",
    summary: "Inbound WhatsApp messages (X-Hub-Signature-256 over the raw body; deduped by message id)",
    tags: ["Webhooks"],
    access: "webhook:meta",
    body: WhatsAppWebhookBody,
    response: WhatsAppResult,
  },
]);
