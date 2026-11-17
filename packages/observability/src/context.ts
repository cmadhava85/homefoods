import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type RequestCorr = {
  /** Per-HTTP-request id (changes on each webhook delivery). */
  requestId: string;
  /**
   * Durable business journey id — same across order create, Razorpay webhooks,
   * outbox, and worker. Prefer this when debugging a payment/order.
   */
  traceId?: string;
  route?: string;
  userId?: string;
  publicId?: string;
  checkoutId?: string;
};

const storage = new AsyncLocalStorage<RequestCorr>();

/** `trc_` + 32 hex chars — stable across webhooks for one checkout/order. */
export function newTraceId(): string {
  return `trc_${randomUUID().replace(/-/g, "")}`;
}

export function runWithCorr<T>(corr: RequestCorr, fn: () => T): T;
export function runWithCorr(corr: RequestCorr, fn: (err?: Error) => void): void;
export function runWithCorr<T>(corr: RequestCorr, fn: (() => T) | ((err?: Error) => void)): T | void {
  return storage.run(corr, fn as () => T);
}

export function getCorr(): RequestCorr | undefined {
  return storage.getStore();
}

export function setCorrField(patch: Partial<RequestCorr>): void {
  const cur = storage.getStore();
  if (!cur) return;
  Object.assign(cur, patch);
}

/** Bind the durable journey id (and optional order keys) into the current request. */
export function bindTrace(input: {
  traceId: string;
  publicId?: string | null;
  checkoutId?: string | null;
}): void {
  setCorrField({
    traceId: input.traceId,
    ...(input.publicId ? { publicId: input.publicId } : {}),
    ...(input.checkoutId ? { checkoutId: input.checkoutId } : {}),
  });
}

/** Embedded on outbox payloads so the worker can join logs to the API request. */
export const CORR_PAYLOAD_KEY = "_corr";

export type OutboxCorr = {
  traceId?: string;
  requestId?: string;
  publicId?: string;
  checkoutId?: string;
};

function pickStr(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function withCorr<T extends Record<string, unknown>>(payload: T): T & {
  traceId?: string;
  [CORR_PAYLOAD_KEY]: OutboxCorr;
} {
  const ctx = getCorr();
  const publicId = pickStr(payload.publicId, payload.orderPublicId, ctx?.publicId);
  const checkoutId = pickStr(payload.checkoutId, ctx?.checkoutId);
  const traceId = pickStr(payload.traceId, ctx?.traceId);
  const corr: OutboxCorr = {
    ...(traceId ? { traceId } : {}),
    ...(ctx?.requestId ? { requestId: ctx.requestId } : {}),
    ...(publicId ? { publicId } : {}),
    ...(checkoutId ? { checkoutId } : {}),
  };
  return {
    ...payload,
    ...(traceId && typeof payload.traceId !== "string" ? { traceId } : {}),
    [CORR_PAYLOAD_KEY]: corr,
  };
}

export function readCorr(payload: Record<string, unknown>): OutboxCorr {
  const raw = payload[CORR_PAYLOAD_KEY];
  if (!raw || typeof raw !== "object") {
    return {
      traceId: pickStr(payload.traceId),
      publicId: pickStr(payload.publicId, payload.orderPublicId),
      checkoutId: pickStr(payload.checkoutId),
    };
  }
  const c = raw as Record<string, unknown>;
  return {
    traceId: pickStr(c.traceId, payload.traceId),
    requestId: pickStr(c.requestId),
    publicId: pickStr(c.publicId, payload.publicId, payload.orderPublicId),
    checkoutId: pickStr(c.checkoutId, payload.checkoutId),
  };
}
