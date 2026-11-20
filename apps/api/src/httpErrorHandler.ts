import type { FastifyInstance, FastifyReply } from "fastify";
import { DEFAULT_LOCALE, type Locale } from "@localmeals/i18n";
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

/** Use in route catch blocks so auth / not-found get correct status codes. */
export function sendCaughtError(reply: FastifyReply, err: unknown) {
  const locale = localeFromReply(reply);
  const status = httpStatusForError(err);
  const error = publicErrorMessage(err, locale);
  return reply.code(status).send({ error });
}

export function registerApiErrorHandler(app: FastifyInstance) {
  app.decorateRequest("locale", DEFAULT_LOCALE);
  app.addHook("onRequest", async (req) => {
    req.locale = resolveRequestLocale(req);
  });

  app.setErrorHandler((err, req, reply) => {
    const locale = req.locale ?? DEFAULT_LOCALE;
    const status = httpStatusForError(err);
    const error = publicErrorMessage(err, locale);
    const triage = triageFromCorr();
    if (status >= 500) {
      req.log.error(
        { err, event: LogEvent.REQUEST_FAILED, status, ...triage, method: req.method, url: req.url },
        error,
      );
    } else {
      req.log.warn(
        {
          err: { message: error, name: (err as Error)?.name },
          event: LogEvent.REQUEST_FAILED,
          status,
          ...triage,
          method: req.method,
          url: req.url,
        },
        "request failed",
      );
    }
    return reply.code(status).send({ error });
  });
}
