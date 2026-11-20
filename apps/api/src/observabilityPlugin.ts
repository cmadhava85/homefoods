import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  LogEvent,
  getCorr,
  maskMobile,
  runWithCorr,
  setCorrField,
} from "@localmeals/observability";

const QUIET_PATHS = new Set(["/health", "/meta/features", "/meta/today"]);

function headerString(
  headers: FastifyRequest["headers"],
  name: string,
): string | undefined {
  const raw = headers[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function routePath(req: FastifyRequest): string {
  return req.routeOptions?.url ?? req.url.split("?")[0] ?? req.url;
}

/** Flat triage + session fields for every structured access / business log. */
export function triageFromCorr(): Record<string, string | number> {
  const corr = getCorr();
  if (!corr) return {};
  const out: Record<string, string | number> = {};
  const put = (k: string, v: string | number | undefined) => {
    if (v == null || v === "") return;
    out[k] = v;
  };
  put("traceId", corr.traceId);
  put("publicId", corr.publicId);
  put("checkoutId", corr.checkoutId);
  put("customerMobile", corr.customerMobile);
  put("cookSlug", corr.cookSlug);
  put("cookId", corr.cookId);
  put("orderId", corr.orderId);
  put("status", corr.status);
  put("amountPaise", corr.amountPaise);
  put("mealType", corr.mealType);
  put("serviceDate", corr.serviceDate);
  put("sessionMobile", corr.sessionMobile);
  put("sessionRole", corr.sessionRole);
  return out;
}

function childFromCorr(req: FastifyRequest) {
  const triage = triageFromCorr();
  if (!Object.keys(triage).length) return;
  const r = req as FastifyRequest & { _baseLog?: FastifyRequest["log"] };
  if (!r._baseLog) r._baseLog = req.log;
  req.log = r._baseLog.child(triage);
}

/**
 * Stable request IDs + optional inbound X-Trace-Id + AsyncLocalStorage correlation
 * so outbox enqueues / webhook handlers share one durable traceId.
 *
 * Always emits one structured `request.completed` access log (Fastify default
 * request logging is disabled) so ops can filter by method/url/status/duration
 * and join to order fields when bindTrace ran.
 */
export function registerObservability(app: FastifyInstance) {
  app.addHook("onRequest", (req, reply, done) => {
    const requestId = req.id;
    const inboundTrace = headerString(req.headers, "x-trace-id");
    reply.header("X-Request-Id", requestId);
    if (inboundTrace) reply.header("X-Trace-Id", inboundTrace.slice(0, 40));
    (req as { _startedAt?: number })._startedAt = Date.now();
    runWithCorr(
      {
        requestId,
        ...(inboundTrace ? { traceId: inboundTrace.slice(0, 40) } : {}),
        route: `${req.method} ${routePath(req)}`,
      },
      done,
    );
  });

  // Session hook runs as another preHandler — stamp identity here after handlers.
  app.addHook("preSerialization", async (req) => {
    const session = (req as { sessionUser?: { mobile?: string; role?: string } | null })
      .sessionUser;
    if (session?.mobile) {
      setCorrField({
        sessionMobile: maskMobile(session.mobile),
        ...(session.role ? { sessionRole: session.role } : {}),
      });
    }
    childFromCorr(req);
  });

  // Headers must be set before the response is flushed (onResponse is too late).
  app.addHook("onSend", async (req, reply, payload) => {
    const corr = getCorr();
    if (corr?.traceId) {
      reply.header("X-Trace-Id", corr.traceId);
      childFromCorr(req);
    }
    return payload;
  });

  app.addHook("onResponse", async (req, reply) => {
    childFromCorr(req);

    const path = routePath(req);
    const started = (req as { _startedAt?: number })._startedAt;
    const durationMs = started != null ? Date.now() - started : undefined;
    const quiet = QUIET_PATHS.has(path);
    const payload = {
      event: LogEvent.REQUEST_COMPLETED,
      ...triageFromCorr(),
      method: req.method,
      url: path,
      statusCode: reply.statusCode,
      ...(durationMs != null ? { durationMs } : {}),
      requestId: req.id,
    };

    if (quiet) {
      req.log.debug(payload, "request completed");
      return;
    }
    if (reply.statusCode >= 500) {
      req.log.error(payload, "request completed");
    } else if (reply.statusCode >= 400) {
      req.log.warn(payload, "request completed");
    } else {
      req.log.info(payload, "request completed");
    }
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
