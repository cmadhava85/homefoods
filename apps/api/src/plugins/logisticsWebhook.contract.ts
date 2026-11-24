import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import { OrderPublicId, OrderStatus, Text } from "../openapi/shared.js";
import { JsonObject } from "./adminShared.contract.js";

export const LogisticsWebhookBody = JsonObject.describe(
  "Shipment update — LocalMeals shape or common vendor aliases (see docs/LOGISTICS.md)",
);

export const logisticsOperations = defineOperations([
  {
    method: "post",
    path: "/webhooks/logistics",
    operationId: "logisticsWebhook",
    summary: "Partner logistics status update (X-Logistics-Secret and/or HMAC X-Logistics-Signature)",
    tags: ["Webhooks"],
    access: "webhook:logistics",
    body: LogisticsWebhookBody,
    response: z.object({
      ok: z.literal(true),
      publicId: OrderPublicId,
      status: OrderStatus,
      partnerShipmentId: z.string().max(100).nullable(),
      traceId: Text(40).optional(),
    }),
    errors: { 404: "Unknown shipment / order" },
  },
]);
