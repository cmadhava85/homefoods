import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@localmeals/db";
import { sendCaughtError } from "../httpErrors.js";
import { applyPartnerShipmentUpdate } from "../services/partnerLogistics.js";

/**
 * Partner logistics webhook (Shadowfax/etc.).
 * Auth: shared secret header until vendor HMAC is wired.
 */
export async function logisticsWebhook(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.post("/webhooks/logistics", async (req, reply) => {
    const expected = process.env.LOGISTICS_WEBHOOK_SECRET?.trim();
    if (expected) {
      const got = String(req.headers["x-logistics-secret"] ?? "");
      if (got !== expected) {
        return reply.code(401).send({ error: "Invalid logistics webhook secret" });
      }
    } else if (process.env.NODE_ENV === "production") {
      return reply.code(503).send({ error: "LOGISTICS_WEBHOOK_SECRET not configured" });
    }

    try {
      const body = z
        .object({
          partnerShipmentId: z.string().min(4),
          status: z.enum(["CREATED", "ASSIGNED", "PICKED_UP", "DELIVERED", "FAILED"]),
        })
        .parse(req.body);

      const order = await applyPartnerShipmentUpdate(db, body);
      return {
        ok: true,
        publicId: order.publicId,
        status: order.status,
        partnerShipmentId: order.partnerShipmentId,
      };
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });
}
