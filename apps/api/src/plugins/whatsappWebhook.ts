import type { FastifyInstance } from "fastify";
import type { Db } from "@localmeals/db";
import { processWaInboundOnce } from "../services/waInboundDedupe.js";
import { LogEvent } from "@localmeals/observability";
import {
  getWhatsAppProvider,
  isMockWhatsApp,
  extractInboundWhatsApp,
} from "@localmeals/adapters";
import { handleWhatsAppInbound } from "../wa/dispatch.js";
import { WhatsAppVerifyQuery } from "./whatsappWebhook.contract.js";

export async function whatsappWebhook(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  app.get("/webhooks/whatsapp", async (req, reply) => {
    const q = WhatsAppVerifyQuery.parse(req.query ?? {}) as Record<string, string>;
    const wa = getWhatsAppProvider();
    if (wa.verifyWebhook(q) && q["hub.mode"] === "subscribe") {
      reply.type("text/plain").send(q["hub.challenge"] ?? "ok");
      return;
    }
    return reply.code(403).send("forbidden");
  });

  app.post("/webhooks/whatsapp", async (req, reply) => {
    const waGate = getWhatsAppProvider();
    if (!isMockWhatsApp(waGate) && waGate.verifyIncomingSignature) {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
      ) as Record<string, string | undefined>;
      const rawBody = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});
      if (!waGate.verifyIncomingSignature(headers, rawBody)) {
        req.log.warn(
          { event: LogEvent.WEBHOOK_SIGNATURE_FAILED, provider: "whatsapp" },
          "whatsapp webhook signature rejected",
        );
        return reply.code(401).send({ error: "Could not verify the request" });
      }
    }

    const inbound = extractInboundWhatsApp(req.body);
    if (!inbound.from || (!inbound.text && !inbound.image)) {
      return { ok: true, ignored: true };
    }

    const localeHint = inbound.locale ?? (req as { locale?: string }).locale;
    // Process inline — Cloud Run cpu_idle can drop setImmediate work after 200 (R4).
    // Meta allows ~10s; mock tests also need the handler result in the HTTP body.
    const run = () =>
      handleWhatsAppInbound({
        db,
        from: inbound.from!,
        text: inbound.text ?? "",
        image: inbound.image,
        localeHint,
      });
    try {
      const outcome = await processWaInboundOnce(
        db,
        { wamid: inbound.messageId, from: inbound.from },
        run,
      );
      return outcome.duplicate ? { ok: true, duplicate: true } : outcome.result;
    } catch (err) {
      req.log.error(
        {
          event: LogEvent.WEBHOOK_HANDLER_FAILED,
          provider: "whatsapp",
          err: err instanceof Error ? err.message : String(err),
        },
        "whatsapp inbound handler failed — dedupe released for Meta redelivery",
      );
      throw err;
    }
  });
}
