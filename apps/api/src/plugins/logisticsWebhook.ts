import type { FastifyInstance } from "fastify";
import type { Db } from "@localmeals/db";
import {
  normalizeLogisticsWebhookPayload,
  verifyLogisticsWebhookAuth,
} from "@localmeals/adapters";
import { bindTrace } from "@localmeals/observability";
import { sendCaughtError } from "../httpErrors.js";
import { applyPartnerShipmentUpdate } from "../services/partnerLogistics.js";

/**
 * Partner logistics webhook (Shadowfax / Porter / HTTP gateway).
 * Auth: `X-Logistics-Secret` and/or HMAC `X-Logistics-Signature` (sha256 hex of raw body).
 * Body: LocalMeals shape or common vendor aliases — see docs/LOGISTICS.md.
 * Prefer echoed `traceId` from createShipment metadata for Cloud Logging joins.
 */
export async function logisticsWebhook(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/webhooks/logistics", async (req, reply) => {
    const rawBody =
      (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
    const auth = verifyLogisticsWebhookAuth({
      headers: req.headers as Record<string, unknown>,
      rawBody,
    });
    if (!auth.ok) {
      return reply.code(auth.status).send({ error: auth.error });
    }

    try {
      const event = normalizeLogisticsWebhookPayload(req.body);
      const order = await applyPartnerShipmentUpdate(db, event);
      const traceId = event.traceId?.trim() || order.traceId?.trim();
      if (traceId) {
        bindTrace({
          traceId,
          publicId: order.publicId,
          customerMobile: order.customerMobile,
          cookId: order.cookId,
          orderId: order.id,
          status: order.status,
          mealType: order.mealType,
          serviceDate: order.serviceDate,
        });
      }
      return {
        ok: true,
        publicId: order.publicId,
        status: order.status,
        partnerShipmentId: order.partnerShipmentId,
        ...(traceId ? { traceId } : {}),
      };
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });
}
