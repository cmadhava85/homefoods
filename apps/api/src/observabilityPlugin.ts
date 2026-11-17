import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { LogEvent, getCorr, runWithCorr } from "@localmeals/observability";

function headerString(
  headers: FastifyRequest["headers"],
  name: string,
): string | undefined {
  const raw = headers[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function childFromCorr(req: FastifyRequest) {
  const corr = getCorr();
  if (!corr?.traceId) return;
  req.log = req.log.child({
    traceId: corr.traceId,
    ...(corr.publicId ? { publicId: corr.publicId } : {}),
    ...(corr.checkoutId ? { checkoutId: corr.checkoutId } : {}),
  });
}

/**
 * Stable request IDs + optional inbound X-Trace-Id + AsyncLocalStorage correlation
 * so outbox enqueues / webhook handlers share one durable traceId.
 */
export function registerObservability(app: FastifyInstance) {
  app.addHook("onRequest", (req, reply, done) => {
    const requestId = req.id;
    const inboundTrace = headerString(req.headers, "x-trace-id");
    reply.header("X-Request-Id", requestId);
    if (inboundTrace) reply.header("X-Trace-Id", inboundTrace.slice(0, 40));
    runWithCorr(
      {
        requestId,
        ...(inboundTrace ? { traceId: inboundTrace.slice(0, 40) } : {}),
        route: `${req.method} ${req.routeOptions?.url ?? req.url.split("?")[0]}`,
      },
      done,
    );
  });

  // Handlers call bindTrace mid-request — refresh logger before serialization.
  app.addHook("preSerialization", async (req) => {
    childFromCorr(req);
  });

  // After handlers bindTrace(...), surface the durable id on the response + log once.
  app.addHook("onSend", async (req, reply, payload) => {
    const corr = getCorr();
    if (corr?.traceId) {
      reply.header("X-Trace-Id", corr.traceId);
      childFromCorr(req);
      req.log.info(
        {
          event: LogEvent.REQUEST_COMPLETED,
          traceId: corr.traceId,
          ...(corr.publicId ? { publicId: corr.publicId } : {}),
          ...(corr.checkoutId ? { checkoutId: corr.checkoutId } : {}),
        },
        "request completed",
      );
    }
    return payload;
  });
}

export function genRequestId(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers["x-request-id"];
  const fromHeader = Array.isArray(raw) ? raw[0] : raw;
  if (typeof fromHeader === "string" && fromHeader.trim().length >= 8) {
    return fromHeader.trim().slice(0, 128);
  }
  return randomUUID();
}
