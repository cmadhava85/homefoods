import type { FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  DEFAULT_LOCALE,
  localizeError,
  parseLocale,
  type Locale,
} from "@localmeals/i18n";

declare module "fastify" {
  interface FastifyRequest {
    locale: Locale;
  }
}

export function resolveRequestLocale(req: FastifyRequest): Locale {
  const x = req.headers["x-locale"];
  if (typeof x === "string" && x.trim()) return parseLocale(x);
  if (Array.isArray(x) && x[0]) return parseLocale(x[0]);
  const al = req.headers["accept-language"];
  if (typeof al === "string") return parseLocale(al);
  return DEFAULT_LOCALE;
}

/** User-facing copy — never leak Postgres / driver internals. */
export function publicErrorMessage(err: unknown, locale: Locale = DEFAULT_LOCALE): string {
  if (err instanceof ZodError) {
    const first = err.issues[0];
    if (!first) return localizeError(locale, "error.generic");
    const path = first.path.filter((p) => typeof p === "string" || typeof p === "number").join(".");
    if (first.message === "Required" && path) {
      return localizeError(locale, `${path} is required`) === `${path} is required`
        ? `${path} is required`
        : localizeError(locale, `${path} is required`);
    }
    // Prefer localizing known Zod/business messages
    return localizeError(locale, first.message || "error.generic");
  }

  const msg = err instanceof Error ? err.message : String(err ?? "");
  return localizeError(locale, msg);
}

export function httpStatusForError(err: unknown): number {
  if (err instanceof ZodError) return 400;

  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 600) {
    return statusCode;
  }

  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (msg === "Unauthorized" || msg === "error.unauthorized" || /sign in as|please sign in/i.test(msg)) {
    return 401;
  }
  if (
    /forbidden|disabled when|not allowed|mock-confirm disabled|not your kitchen|not your order|error\.mockPayOff/i.test(
      msg,
    )
  ) {
    return 403;
  }
  if (/amount does not match|CORS origin not allowed/i.test(msg)) {
    return 409;
  }
  if (/\bnot found\b|error\.(notFound|kitchenNotFound|orderNotFound|customerNotFound)/i.test(msg)) {
    return 404;
  }
  // Idempotent create races — caller should treat as conflict / replay, not 500.
  if (/duplicate key|unique constraint/i.test(msg)) {
    return 409;
  }
  if (/violates foreign key|ECONNREFUSED|connection refused|postgres|drizzle/i.test(msg)) {
    return 500;
  }
  return 400;
}

export { registerApiErrorHandler, sendCaughtError } from "./httpErrorHandler.js";
