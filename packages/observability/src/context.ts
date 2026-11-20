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
  /** Masked session mobile / role when a user is signed in. */
  sessionMobile?: string;
  sessionRole?: string;
  publicId?: string;
  checkoutId?: string;
  /** Triage fields — set via bindTrace for Cloud Logging filters. */
  customerMobile?: string;
  cookSlug?: string;
  cookId?: string;
  orderId?: number;
  status?: string;
  amountPaise?: number;
  mealType?: string;
  serviceDate?: string;
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

/**
 * Mask the first 3 digits of the local number for logs.
 * Ignores India country code `+91` / `91`.
 * `+919900000001` → `+91***0000001`
 */
export function maskMobile(mobile: string | null | undefined): string {
  if (mobile == null || mobile === "") return "";
  const raw = String(mobile);
  const m = raw.match(/^(\+?91)?(.*)$/);
  const prefix = m?.[1] ?? "";
  const rest = m?.[2] ?? raw;
  let seen = 0;
  const maskedRest = rest.replace(/\d/g, (d) => {
    if (seen < 3) {
      seen += 1;
      return "*";
    }
    return d;
  });
  return `${prefix}${maskedRest}`;
}

/** Bind the durable journey id (and optional order keys) into the current request. */
export function bindTrace(input: {
  traceId: string;
  publicId?: string | null;
  checkoutId?: string | null;
  customerMobile?: string | null;
  cookSlug?: string | null;
  cookId?: string | null;
  orderId?: number | null;
  status?: string | null;
  amountPaise?: number | null;
  mealType?: string | null;
  serviceDate?: string | null;
}): void {
  setCorrField({
    traceId: input.traceId,
    ...(input.publicId ? { publicId: input.publicId } : {}),
    ...(input.checkoutId ? { checkoutId: input.checkoutId } : {}),
    ...(input.customerMobile
      ? { customerMobile: maskMobile(input.customerMobile) }
      : {}),
    ...(input.cookSlug ? { cookSlug: input.cookSlug } : {}),
    ...(input.cookId ? { cookId: input.cookId } : {}),
    ...(input.orderId != null ? { orderId: input.orderId } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(typeof input.amountPaise === "number" ? { amountPaise: input.amountPaise } : {}),
    ...(input.mealType ? { mealType: input.mealType } : {}),
    ...(input.serviceDate ? { serviceDate: input.serviceDate } : {}),
  });
}

/** Flat fields for order/payment triage logs (Cloud Logging jsonPayload). */
export function orderTriageFields(input: {
  publicId?: string | null;
  checkoutId?: string | null;
  traceId?: string | null;
  orderId?: number | null;
  customerMobile?: string | null;
  cookSlug?: string | null;
  cookId?: string | null;
  kitchenName?: string | null;
  status?: string | null;
  amountPaise?: number | null;
  mealType?: string | null;
  serviceDate?: string | null;
  itemName?: string | null;
  qty?: number | null;
  fulfillmentMode?: string | null;
  channel?: string | null;
  pinCode?: string | null;
}): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  const put = (k: string, v: string | number | null | undefined) => {
    if (v == null || v === "") return;
    out[k] = v;
  };
  put("publicId", input.publicId);
  put("checkoutId", input.checkoutId);
  put("traceId", input.traceId);
  put("orderId", input.orderId ?? undefined);
  put("customerMobile", maskMobile(input.customerMobile) || undefined);
  put("cookSlug", input.cookSlug);
  put("cookId", input.cookId);
  put("kitchenName", input.kitchenName);
  put("status", input.status);
  put("amountPaise", input.amountPaise ?? undefined);
  put("mealType", input.mealType);
  put("serviceDate", input.serviceDate);
  put("itemName", input.itemName);
  put("qty", input.qty ?? undefined);
  put("fulfillmentMode", input.fulfillmentMode);
  put("channel", input.channel);
  put("pinCode", input.pinCode);
  return out;
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
