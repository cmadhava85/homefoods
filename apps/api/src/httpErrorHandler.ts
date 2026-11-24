import type { FastifyInstance, FastifyReply } from "fastify";
import { DEFAULT_LOCALE, localizeError, type Locale } from "@localmeals/i18n";
import { LogEvent } from "@localmeals/observability";
import {
  httpStatusForError,
  publicErrorMessage,
  resolveRequestLocale,
} from "./httpErrors.js";
import { triageFromCorr } from "./observabilityPlugin.js";

function localeFromReply(reply: FastifyReply): Locale {
  return reply.request?.locale ?? DEFAULT_LOCALE;
}

function errorBody(reply: FastifyReply, status: number, err: unknown, locale: Locale) {
  const triage = triageFromCorr();
  const requestId =
    (typeof reply.request?.id === "string" && reply.request.id) ||
    (typeof triage.requestId === "string" && triage.requestId) ||
    undefined;
  const error =
    status >= 500 ? localizeError(locale, "error.generic") : publicErrorMessage(err, locale);
  return {
    error,
    ...(requestId ? { requestId } : {}),
    ...(typeof triage.traceId === "string" && triage.traceId ? { traceId: triage.traceId } : {}),
  };
}

/** Use in route catch blocks so auth / not-found get correct status codes. */
export function sendCaughtError(reply: FastifyReply, err: unknown) {
  const locale = localeFromReply(reply);
  const status = httpStatusForError(err);
  const triage = triageFromCorr();
  const log = reply.request?.log;
  if (status >= 500) {
    log?.error(
      {
        err,
        event: LogEvent.REQUEST_FAILED,
        status,
        ...triage,
        method: reply.request?.method,
        url: reply.request?.url,
      },
      "request failed",
    );
  }
  return reply.code(status).send(errorBody(reply, status, err, locale));
}

export function registerApiErrorHandler(app: FastifyInstance) {
  app.decorateRequest("locale", DEFAULT_LOCALE);
  app.addHook("onRequest", async (req) => {
    req.locale = resolveRequestLocale(req);
  });

  app.setErrorHandler((err, req, reply) => {
    const locale = req.locale ?? DEFAULT_LOCALE;
    const status = httpStatusForError(err);
    const triage = triageFromCorr();
    if (status >= 500) {
      req.log.error(
        { err, event: LogEvent.REQUEST_FAILED, status, ...triage, method: req.method, url: req.url },
        "request failed",
      );
    } else {
      req.log.warn(
        {
          err: { message: publicErrorMessage(err, locale), name: (err as Error)?.name },
          event: LogEvent.REQUEST_FAILED,
          status,
          ...triage,
          method: req.method,
          url: req.url,
        },
        "request failed",
      );
    }
    return reply.code(status).send(errorBody(reply, status, err, locale));
  });
}
