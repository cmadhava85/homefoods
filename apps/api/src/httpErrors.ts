import type { FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  DEFAULT_LOCALE,
  knownErrorKey,
  localizeError,
  parseLocale,
  type Locale,
} from "@localmeals/i18n";
import { DomainError, isDomainError } from "@localmeals/domain";

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

/** Typed HTTP failure for routes — prefer over bare Error when status is known. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 400, code = "http_error") {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Upstream (Razorpay / Meta / …) failure — maps to 502/503/504. */
export class UpstreamError extends Error {
  readonly statusCode: number;
  readonly provider: string;

  constructor(message: string, statusCode: 502 | 503 | 504, provider: string) {
    super(message);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
    this.provider = provider;
  }
}

function driverCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { code?: unknown; cause?: { code?: unknown }; errno?: unknown };
  if (typeof e.code === "string") return e.code;
  if (typeof e.cause?.code === "string") return e.cause.code;
  if (typeof e.errno === "string") return e.errno;
  return undefined;
}

/** User-facing copy — never leak Postgres / driver / 5xx internals. */
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
    return localizeError(locale, first.message || "error.generic");
  }

  const status = httpStatusForError(err);
  if (status >= 500) {
    return localizeError(locale, "error.generic");
  }

  const msg = err instanceof Error ? err.message : String(err ?? "");
  return localizeError(locale, msg);
}

export function httpStatusForError(err: unknown): number {
  if (err instanceof ZodError) return 400;
  if (isDomainError(err)) return err.statusCode;
  if (err instanceof HttpError || err instanceof UpstreamError) return err.statusCode;

  const statusCode = (err as { statusCode?: number })?.statusCode;
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 600) {
    return statusCode;
  }

  const code = driverCode(err);
  // Undefined column / missing relation / admin shutdown → service unavailable (schema/DB).
  if (code === "42703" || code === "42P01" || code === "57P01") return 503;
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EPIPE" ||
    code === "CONNECTION_CLOSED" ||
    code === "57P03"
  ) {
    return 503;
  }

  // Non-JSON gateway body / broken upstream payload.
  if (err instanceof SyntaxError) return 502;

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
  // Customer-facing catalog errors that are still thrown as bare Error in places.
  if (/cut-off passed|Kitchen at capacity|That plate is not available|is not offered by this kitchen/i.test(msg)) {
    return 400;
  }
  if (/\bnot found\b|error\.(notFound|kitchenNotFound|orderNotFound|customerNotFound)/i.test(msg)) {
    return 404;
  }
  if (/duplicate key|unique constraint/i.test(msg)) {
    return 409;
  }
  if (/violates foreign key|ECONNREFUSED|connection refused|postgres|drizzle/i.test(msg)) {
    return 503;
  }

  // Known customer-facing catalog copy stays 4xx (typed DomainError is preferred going forward).
  const key = knownErrorKey(msg);
  if (key && key !== "error.generic") {
    return 400;
  }

  // Unclassified → server fault (was 400; that hid outages from 5xx alerts).
  return 500;
}

export { DomainError, isDomainError };
export { registerApiErrorHandler, sendCaughtError } from "./httpErrorHandler.js";
