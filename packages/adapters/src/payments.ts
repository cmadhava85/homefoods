import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Razorpay rejects payment links whose `expire_by` is < 15 min in the future. */
export const RAZORPAY_MIN_LINK_TTL_SEC = 15 * 60;
/** Payment link lifetime. Stays above Razorpay's minimum even with clock skew / latency. */
export const PAYMENT_LINK_TTL_SEC = 20 * 60;
/** Unpaid soft hold outlives the link so a hold never expires while its link is still payable. */
export const UNPAID_HOLD_TTL_SEC = PAYMENT_LINK_TTL_SEC + 5 * 60;

/** Unix `expire_by` for a new link, clamped to Razorpay's minimum (+1 min safety). */
export function paymentLinkExpireBy(nowMs = Date.now(), requestedUnix?: number): number {
  const nowSec = Math.floor(nowMs / 1000);
  const minUnix = nowSec + RAZORPAY_MIN_LINK_TTL_SEC + 60;
  return Math.max(requestedUnix ?? nowSec + PAYMENT_LINK_TTL_SEC, minUnix);
}

export type CreatePaymentInput = {
  orderPublicId: string;
  amountPaise: number;
  customerMobile: string;
  idempotencyKey: string;
  /** Durable journey id — echoed in Razorpay notes for webhook correlation. */
  traceId?: string;
  notes?: Record<string, string>;
  /** Unix seconds; defaults to now + PAYMENT_LINK_TTL_SEC, never below Razorpay's 15-min minimum. */
  expireAtUnix?: number;
};

export type CreatePaymentResult = {
  gatewayTxnId: string;
  paymentUrl: string;
  provider: "mock" | "razorpay";
  /** UPI QR only: image to show the customer (scan with any UPI app). */
  qrImageUrl?: string;
};

/** Normalized gateway webhook kinds LocalMeals acts on. */
export type GatewayWebhookKind =
  | "PAYMENT_CAPTURED"
  | "PAYMENT_FAILED"
  | "PAYMENT_AUTHORIZED"
  | "REFUND_PROCESSED"
  | "REFUND_FAILED"
  | "TRANSFER_PROCESSED"
  | "TRANSFER_FAILED"
  | "PAYOUT_PROCESSED"
  | "PAYOUT_FAILED"
  | "PAYOUT_REVERSED"
  | "SETTLEMENT_PROCESSED"
  | "ROUTE_ACCOUNT"
  | "IGNORED";

export type GatewayWebhookEvent = {
  kind: GatewayWebhookKind;
  event: string;
  /** Payment link id (plink_…) — matches orders.gateway_txn_id for our createPayment. */
  gatewayTxnId?: string;
  paymentId?: string;
  refundId?: string;
  transferId?: string;
  payoutId?: string;
  settlementGatewayId?: string;
  accountId?: string;
  amountPaise?: number;
  utr?: string;
  status?: string;
  orderPublicId?: string;
  notes?: Record<string, string>;
  raw: unknown;
};

/** @deprecated Prefer GatewayWebhookEvent — kept for mock simple captures. */
export type PaymentCapture = {
  gatewayTxnId: string;
  status: "captured" | "paid" | "ignored" | string;
  raw: unknown;
};

export type RefundPaymentInput = {
  /** Razorpay payment id `pay_…` (preferred) or payment link `plink_…` to resolve. */
  paymentId: string;
  amountPaise: number;
  notes?: Record<string, string>;
  receipt?: string;
};

export type RefundPaymentResult = {
  refundId: string;
  paymentId: string;
  amountPaise: number;
  status: string;
  provider: "mock" | "razorpay";
};

export type TransferToAccountInput = {
  /** Linked account id (`acc_…`) stored as cook.payoutBeneficiaryRef */
  accountId: string;
  amountPaise: number;
  notes?: Record<string, string>;
};

export type TransferToAccountResult = {
  transferId: string;
  amountPaise: number;
  status: string;
  provider: "mock" | "razorpay";
};

export type PaymentProvider = {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Single-use, fixed-amount Razorpay UPI QR (0.99% vs 2% for links). gatewayTxnId = qr_… */
  createUpiQr(input: CreatePaymentInput): Promise<CreatePaymentResult & { qrImageUrl: string }>;
  verifyWebhookSignature(headers: Record<string, string | undefined>, rawBody: string): boolean;
  parseWebhook?(body: unknown): GatewayWebhookEvent | null;
  /** Create a refund against a captured Razorpay payment. */
  refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult>;
  /** Resolve `pay_…` from a payment link id when webhook didn't stamp it. */
  resolvePaymentId(paymentLinkOrPayId: string): Promise<string | null>;
  /** Fetch payment link status (paid / created / expired) for return-URL confirm. */
  getPaymentLinkStatus?(
    paymentLinkId: string,
  ): Promise<{ status: string; paymentId: string | null; amountPaise?: number }>;
  /** Cancel an open payment link (plink_…) so it cannot be paid after hold expiry. */
  cancelPaymentLink?(paymentLinkId: string): Promise<void>;
  /** Route direct transfer to a cook linked account (EOD). */
  transferToLinkedAccount(input: TransferToAccountInput): Promise<TransferToAccountResult>;
};

function razorpayBasicAuth(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID/SECRET missing — use MOCK_PAYMENTS=true locally");
  }
  return Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

/**
 * Razorpay caps Idempotency-Key at 64 chars. Truncating would make keys that differ only in their
 * tail (e.g. a re-order's `|addl|<id>` suffix) collide and replay the old link, so hash long keys.
 */
export function gatewayIdempotencyHeader(key: string): string {
  return key.length <= 64 ? key : createHash("sha256").update(key).digest("hex");
}

async function razorpayFetch<T>(
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<T> {
  const { idempotencyKey, headers: extra, ...rest } = init;
  const headers: Record<string, string> = {
    Authorization: `Basic ${razorpayBasicAuth()}`,
    "Content-Type": "application/json",
    ...(extra as Record<string, string> | undefined),
  };
  if (idempotencyKey) headers["Idempotency-Key"] = gatewayIdempotencyHeader(idempotencyKey);
  const { fetchWithTimeout, UpstreamHttpError } = await import("./fetchWithTimeout.js");
  const timeoutMs = Number(process.env.RAZORPAY_TIMEOUT_MS ?? 10_000);
  try {
    const { json } = await fetchWithTimeout(
      `https://api.razorpay.com/v1${path}`,
      { ...rest, headers },
      {
        timeoutMs,
        retries: idempotencyKey ? 2 : 0,
        retryOnTransient: Boolean(idempotencyKey),
        provider: "razorpay",
        path,
      },
    );
    const body = (json ?? {}) as T & { error?: { description?: string } };
    return body;
  } catch (err) {
    if (err instanceof UpstreamHttpError) {
      throw Object.assign(new Error(err.message), { statusCode: err.statusCode, name: "UpstreamError" });
    }
    throw err;
  }
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function entityOf(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const wrap = asRecord(payload[key]);
  return asRecord(wrap.entity ?? wrap);
}

function notesOf(entity: Record<string, unknown>): Record<string, string> {
  const n = asRecord(entity.notes);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(n)) {
    if (v != null) out[k] = String(v);
  }
  return out;
}

/**
 * Classify Razorpay (or mock) webhook body into a LocalMeals action.
 * Always returns an event — unknown events → IGNORED (HTTP 200 ack).
 */
export function classifyPaymentWebhook(body: unknown): GatewayWebhookEvent {
  const b = asRecord(body);

  // Local / simplified test shape
  if (typeof b.gatewayTxnId === "string" && b.gatewayTxnId) {
    const status = String(b.status ?? "captured").toLowerCase();
    if (status === "captured" || status === "paid") {
      return {
        kind: "PAYMENT_CAPTURED",
        event: "mock.capture",
        gatewayTxnId: b.gatewayTxnId,
        status,
        raw: body,
      };
    }
    if (status === "failed") {
      return {
        kind: "PAYMENT_FAILED",
        event: "mock.fail",
        gatewayTxnId: b.gatewayTxnId,
        status,
        raw: body,
      };
    }
  }

  const event = String(b.event ?? "").toLowerCase();
  const payload = asRecord(b.payload);

  switch (event) {
    case "payment_link.paid": {
      const link = entityOf(payload, "payment_link");
      const pay = entityOf(payload, "payment");
      const notes = { ...notesOf(link), ...notesOf(pay) };
      return {
        kind: "PAYMENT_CAPTURED",
        event,
        gatewayTxnId: link.id ? String(link.id) : undefined,
        paymentId: pay.id ? String(pay.id) : undefined,
        orderPublicId: notes.orderPublicId ?? (link.reference_id ? String(link.reference_id) : undefined),
        amountPaise: typeof link.amount_paid === "number" ? link.amount_paid : undefined,
        notes,
        status: "captured",
        raw: body,
      };
    }
    case "qr_code.credited": {
      const qr = entityOf(payload, "qr_code");
      const pay = entityOf(payload, "payment");
      const notes = { ...notesOf(qr), ...notesOf(pay) };
      return {
        kind: "PAYMENT_CAPTURED",
        event,
        gatewayTxnId: qr.id ? String(qr.id) : undefined,
        paymentId: pay.id ? String(pay.id) : undefined,
        orderPublicId: notes.orderPublicId,
        amountPaise: typeof pay.amount === "number" ? pay.amount : undefined,
        notes,
        status: "captured",
        raw: body,
      };
    }
    case "payment.captured": {
      const pay = entityOf(payload, "payment");
      const notes = notesOf(pay);
      // Prefer plink_ (matches orders.gateway_txn_id). Never use Razorpay order_… —
      // that is not stored on our order and breaks markOrderPaid lookups.
      const plinkCandidate =
        notes.payment_link_id ?? notes.gatewayTxnId ?? notes.plink_id;
      const gatewayTxnId =
        typeof plinkCandidate === "string" && plinkCandidate.startsWith("plink_")
          ? plinkCandidate
          : undefined;
      return {
        kind: "PAYMENT_CAPTURED",
        event,
        gatewayTxnId,
        paymentId: pay.id ? String(pay.id) : undefined,
        orderPublicId: notes.orderPublicId,
        amountPaise: typeof pay.amount === "number" ? pay.amount : undefined,
        notes,
        status: "captured",
        raw: body,
      };
    }
    case "payment.authorized": {
      const pay = entityOf(payload, "payment");
      const notes = notesOf(pay);
      return {
        kind: "PAYMENT_AUTHORIZED",
        event,
        gatewayTxnId: notes.gatewayTxnId ?? notes.payment_link_id,
        paymentId: pay.id ? String(pay.id) : undefined,
        orderPublicId: notes.orderPublicId,
        notes,
        status: "authorized",
        raw: body,
      };
    }
    case "payment.failed": {
      // UPI often emits payment.failed for declined/abandoned attempts before a
      // later success on the same payment link — do not kill the order.
      const pay = entityOf(payload, "payment");
      const notes = notesOf(pay);
      return {
        kind: "IGNORED",
        event,
        gatewayTxnId: notes.gatewayTxnId ?? notes.payment_link_id,
        paymentId: pay.id ? String(pay.id) : undefined,
        orderPublicId: notes.orderPublicId,
        notes,
        status: "failed_attempt",
        raw: body,
      };
    }
    case "payment_link.expired":
    case "payment_link.cancelled": {
      const link = entityOf(payload, "payment_link");
      const pay = entityOf(payload, "payment");
      const entity = link.id ? link : pay;
      const notes = notesOf(entity);
      return {
        kind: "PAYMENT_FAILED",
        event,
        gatewayTxnId: link.id
          ? String(link.id)
          : notes.gatewayTxnId ?? notes.payment_link_id,
        paymentId: pay.id ? String(pay.id) : undefined,
        orderPublicId: notes.orderPublicId ?? (link.reference_id ? String(link.reference_id) : undefined),
        notes,
        status: "failed",
        raw: body,
      };
    }
    case "refund.processed":
    case "refund.created": {
      const refund = entityOf(payload, "refund");
      const pay = entityOf(payload, "payment");
      const notes = { ...notesOf(pay), ...notesOf(refund) };
      return {
        kind: "REFUND_PROCESSED",
        event,
        refundId: refund.id ? String(refund.id) : undefined,
        paymentId: pay.id ? String(pay.id) : refund.payment_id ? String(refund.payment_id) : undefined,
        gatewayTxnId: notes.gatewayTxnId ?? notes.payment_link_id,
        orderPublicId: notes.orderPublicId,
        amountPaise: typeof refund.amount === "number" ? refund.amount : undefined,
        notes,
        status: String(refund.status ?? "processed"),
        raw: body,
      };
    }
    case "refund.failed": {
      const refund = entityOf(payload, "refund");
      const pay = entityOf(payload, "payment");
      const notes = { ...notesOf(pay), ...notesOf(refund) };
      return {
        kind: "REFUND_FAILED",
        event,
        refundId: refund.id ? String(refund.id) : undefined,
        paymentId: pay.id ? String(pay.id) : undefined,
        gatewayTxnId: notes.gatewayTxnId ?? notes.payment_link_id,
        orderPublicId: notes.orderPublicId,
        notes,
        status: "failed",
        raw: body,
      };
    }
    case "transfer.processed": {
      const transfer = entityOf(payload, "transfer");
      const notes = notesOf(transfer);
      return {
        kind: "TRANSFER_PROCESSED",
        event,
        transferId: transfer.id ? String(transfer.id) : undefined,
        accountId: transfer.recipient ? String(transfer.recipient) : undefined,
        amountPaise: typeof transfer.amount === "number" ? transfer.amount : undefined,
        settlementGatewayId: notes.settlementId ?? notes.gatewayBatchId,
        notes,
        status: String(transfer.status ?? "processed"),
        raw: body,
      };
    }
    case "transfer.failed": {
      const transfer = entityOf(payload, "transfer");
      const notes = notesOf(transfer);
      return {
        kind: "TRANSFER_FAILED",
        event,
        transferId: transfer.id ? String(transfer.id) : undefined,
        accountId: transfer.recipient ? String(transfer.recipient) : undefined,
        settlementGatewayId: notes.settlementId ?? notes.gatewayBatchId,
        notes,
        status: "failed",
        raw: body,
      };
    }
    case "payout.processed":
    case "payout.updated": {
      const payout = entityOf(payload, "payout");
      const notes = notesOf(payout);
      return {
        kind: "PAYOUT_PROCESSED",
        event,
        payoutId: payout.id ? String(payout.id) : undefined,
        amountPaise: typeof payout.amount === "number" ? payout.amount : undefined,
        utr: payout.utr ? String(payout.utr) : undefined,
        settlementGatewayId: notes.settlementId ?? notes.gatewayBatchId ?? (payout.id ? String(payout.id) : undefined),
        notes,
        status: String(payout.status ?? "processed"),
        raw: body,
      };
    }
    case "payout.failed":
    case "payout.rejected": {
      const payout = entityOf(payload, "payout");
      const notes = notesOf(payout);
      return {
        kind: "PAYOUT_FAILED",
        event,
        payoutId: payout.id ? String(payout.id) : undefined,
        settlementGatewayId: notes.settlementId ?? notes.gatewayBatchId,
        notes,
        status: "failed",
        raw: body,
      };
    }
    case "payout.reversed": {
      const payout = entityOf(payload, "payout");
      const notes = notesOf(payout);
      return {
        kind: "PAYOUT_REVERSED",
        event,
        payoutId: payout.id ? String(payout.id) : undefined,
        settlementGatewayId: notes.settlementId ?? notes.gatewayBatchId,
        notes,
        status: "reversed",
        raw: body,
      };
    }
    case "settlement.processed": {
      const settlement = entityOf(payload, "settlement");
      return {
        kind: "SETTLEMENT_PROCESSED",
        event,
        settlementGatewayId: settlement.id ? String(settlement.id) : undefined,
        amountPaise: typeof settlement.amount === "number" ? settlement.amount : undefined,
        utr: settlement.utr ? String(settlement.utr) : undefined,
        status: String(settlement.status ?? "processed"),
        raw: body,
      };
    }
    case "product.route.activated":
    case "product.route.under_review":
    case "product.route.needs_clarification":
    case "account.activated":
    case "account.under_review":
    case "account.needs_clarification":
    case "account.updated": {
      const account = entityOf(payload, "account");
      const product = entityOf(payload, "merchant_product");
      return {
        kind: "ROUTE_ACCOUNT",
        event,
        accountId: account.id
          ? String(account.id)
          : product.merchant_id
            ? String(product.merchant_id)
            : undefined,
        status: String(
          account.activation_status ?? product.activation_status ?? event,
        ),
        raw: body,
      };
    }
    default:
      return { kind: "IGNORED", event: event || "unknown", raw: body };
  }
}

export class MockPaymentProvider implements PaymentProvider {
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const gatewayTxnId = `mock_txn_${input.orderPublicId}`;
    const base = process.env.WEB_ORIGIN ?? "http://localhost:3000";
    return {
      gatewayTxnId,
      paymentUrl: `${base}/pay/${input.orderPublicId}?txn=${gatewayTxnId}`,
      provider: "mock",
    };
  }

  async createUpiQr(input: CreatePaymentInput) {
    const gatewayTxnId = `mock_qr_${input.orderPublicId}`;
    const base = process.env.WEB_ORIGIN ?? "http://localhost:3000";
    return {
      gatewayTxnId,
      paymentUrl: `${base}/pay/${input.orderPublicId}?txn=${gatewayTxnId}`,
      // Placeholder image for local/staging mocks (no real UPI payload).
      qrImageUrl: `data:image/svg+xml,${encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><rect width="220" height="220" fill="#fff" stroke="#0d5840" stroke-width="8"/><text x="110" y="105" font-size="18" text-anchor="middle" font-family="sans-serif">MOCK UPI QR</text><text x="110" y="130" font-size="11" text-anchor="middle" font-family="sans-serif">${input.orderPublicId}</text></svg>`,
      )}`,
      provider: "mock" as const,
    };
  }

  verifyWebhookSignature(
    _headers: Record<string, string | undefined>,
    _rawBody: string,
  ): boolean {
    return true;
  }

  parseWebhook(body: unknown): GatewayWebhookEvent | null {
    return classifyPaymentWebhook(body);
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    return {
      refundId: `mock_rfnd_${input.paymentId}`,
      paymentId: input.paymentId.startsWith("pay_")
        ? input.paymentId
        : `mock_pay_${input.paymentId}`,
      amountPaise: input.amountPaise,
      status: "processed",
      provider: "mock",
    };
  }

  async resolvePaymentId(paymentLinkOrPayId: string): Promise<string | null> {
    if (paymentLinkOrPayId.startsWith("pay_")) return paymentLinkOrPayId;
    if (paymentLinkOrPayId.startsWith("mock_txn_")) {
      return `mock_pay_${paymentLinkOrPayId.replace(/^mock_txn_/, "")}`;
    }
    if (paymentLinkOrPayId.startsWith("mock_qr_")) {
      return `mock_pay_${paymentLinkOrPayId.replace(/^mock_qr_/, "")}`;
    }
    return `mock_pay_${paymentLinkOrPayId}`;
  }

  async getPaymentLinkStatus(paymentLinkId: string) {
    return {
      status: paymentLinkId.startsWith("mock_") ? "paid" : "created",
      paymentId: await this.resolvePaymentId(paymentLinkId),
      amountPaise: undefined as number | undefined,
    };
  }

  async cancelPaymentLink(_paymentLinkId: string): Promise<void> {
    /* mock — no-op */
  }

  async transferToLinkedAccount(
    input: TransferToAccountInput,
  ): Promise<TransferToAccountResult> {
    return {
      transferId: `mock_trf_${input.accountId.slice(0, 8)}_${input.amountPaise}`,
      amountPaise: input.amountPaise,
      status: "processed",
      provider: "mock",
    };
  }
}

/** Razorpay Payment Links + refunds + Route transfers + webhook HMAC. */
export class RazorpayPaymentProvider implements PaymentProvider {
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
    const expireAtUnix = paymentLinkExpireBy(Date.now(), input.expireAtUnix);
    const payload = {
      amount: input.amountPaise,
      currency: "INR",
      accept_partial: false,
      reference_id: input.orderPublicId.slice(0, 40),
      description: `LocalMeals ${input.orderPublicId}`,
      customer: {
        contact: input.customerMobile.replace(/^\+/, ""),
      },
      notify: { sms: false, email: false },
      reminder_enable: false,
      /** Matches unpaid soft-hold so links cannot be paid after order cancel/expiry. */
      expire_by: expireAtUnix,
      callback_url: `${webOrigin}/pay/${input.orderPublicId}`,
      callback_method: "get",
      notes: {
        orderPublicId: input.orderPublicId,
        idempotencyKey: input.idempotencyKey.slice(0, 100),
        ...(input.traceId ? { traceId: input.traceId.slice(0, 40) } : {}),
        ...input.notes,
      },
    };

    const json = await razorpayFetch<{
      id?: string;
      short_url?: string;
    }>("/payment_links", {
      method: "POST",
      body: JSON.stringify(payload),
      idempotencyKey: input.idempotencyKey,
    });

    if (!json.id || !json.short_url) {
      throw new Error("Razorpay payment link missing id/short_url");
    }

    return {
      gatewayTxnId: json.id,
      paymentUrl: json.short_url,
      provider: "razorpay",
    };
  }

  async createUpiQr(input: CreatePaymentInput) {
    const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
    const json = await razorpayFetch<{ id?: string; image_url?: string }>("/payments/qr_codes", {
      method: "POST",
      body: JSON.stringify({
        type: "upi_qr",
        name: "LocalMeals",
        usage: "single_use",
        fixed_amount: true,
        payment_amount: input.amountPaise,
        description: `LocalMeals ${input.orderPublicId}`.slice(0, 100),
        close_by: paymentLinkExpireBy(Date.now(), input.expireAtUnix),
        notes: {
          orderPublicId: input.orderPublicId,
          idempotencyKey: input.idempotencyKey.slice(0, 100),
          ...(input.traceId ? { traceId: input.traceId.slice(0, 40) } : {}),
          ...input.notes,
        },
      }),
      idempotencyKey: `qr|${input.idempotencyKey}`,
    });
    if (!json.id || !json.image_url) throw new Error("Razorpay QR missing id/image_url");
    return {
      gatewayTxnId: json.id,
      paymentUrl: `${webOrigin}/pay/${input.orderPublicId}`,
      qrImageUrl: json.image_url,
      provider: "razorpay" as const,
    };
  }

  verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): boolean {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return false;
    const signature =
      headers["x-razorpay-signature"] ?? headers["X-Razorpay-Signature"];
    if (!signature || !rawBody) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return safeEqualHex(expected, signature);
  }

  parseWebhook(body: unknown): GatewayWebhookEvent | null {
    return classifyPaymentWebhook(body);
  }

  async resolvePaymentId(paymentLinkOrPayId: string): Promise<string | null> {
    if (paymentLinkOrPayId.startsWith("pay_")) return paymentLinkOrPayId;
    if (paymentLinkOrPayId.startsWith("qr_")) {
      const list = await razorpayFetch<{ items?: Array<{ id?: string; status?: string }> }>(
        `/payments/qr_codes/${paymentLinkOrPayId}/payments`,
      );
      const captured = list.items?.find((p) => p.status === "captured") ?? list.items?.[0];
      return captured?.id ?? null;
    }
    if (!paymentLinkOrPayId.startsWith("plink_")) return null;
    const link = await this.fetchPaymentLink(paymentLinkOrPayId);
    const first = link.payments?.[0];
    if (!first) return null;
    if (typeof first === "string") return first;
    return first.payment_id ?? first.id ?? null;
  }

  async getPaymentLinkStatus(paymentLinkId: string) {
    const link = await this.fetchPaymentLink(paymentLinkId);
    const first = link.payments?.[0];
    let paymentId: string | null = null;
    if (typeof first === "string") paymentId = first;
    else if (first) paymentId = first.payment_id ?? first.id ?? null;
    const amountPaise =
      typeof link.amount_paid === "number"
        ? link.amount_paid
        : typeof link.amount === "number"
          ? link.amount
          : undefined;
    return { status: String(link.status ?? "unknown"), paymentId, amountPaise };
  }

  private async fetchPaymentLink(paymentLinkId: string) {
    return razorpayFetch<{
      id?: string;
      status?: string;
      amount?: number;
      amount_paid?: number;
      payments?: Array<string | { payment_id?: string; id?: string }>;
    }>(`/payment_links/${paymentLinkId}`);
  }

  async cancelPaymentLink(paymentLinkId: string): Promise<void> {
    const path = paymentLinkId.startsWith("plink_")
      ? `/payment_links/${paymentLinkId}/cancel`
      : paymentLinkId.startsWith("qr_")
        ? `/payments/qr_codes/${paymentLinkId}/close`
        : null;
    if (!path) return;
    try {
      await razorpayFetch(path, {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (err) {
      // Already paid/expired/cancelled — expire/cancel paths must stay best-effort.
      const msg = err instanceof Error ? err.message : String(err);
      if (/already|expired|cancelled|canceled|closed|paid/i.test(msg)) return;
      throw err;
    }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentResult> {
    const paymentId =
      (await this.resolvePaymentId(input.paymentId)) ??
      (input.paymentId.startsWith("pay_") ? input.paymentId : null);
    if (!paymentId) {
      throw new Error(`Cannot resolve Razorpay payment id from ${input.paymentId}`);
    }
    const json = await razorpayFetch<{
      id?: string;
      payment_id?: string;
      amount?: number;
      status?: string;
    }>(`/payments/${paymentId}/refund`, {
      method: "POST",
      body: JSON.stringify({
        amount: input.amountPaise,
        // "optimum" (Instant Refund) costs ₹7.99+ per refund; normal is free (5–7 days, UPI ~1–3).
        speed: "normal",
        notes: input.notes ?? {},
        receipt: input.receipt?.slice(0, 40),
      }),
      idempotencyKey: input.receipt ?? `rfnd_${paymentId}_${input.amountPaise}`,
    });
    if (!json.id) throw new Error("Razorpay refund missing id");
    return {
      refundId: json.id,
      paymentId: json.payment_id ?? paymentId,
      amountPaise: json.amount ?? input.amountPaise,
      status: json.status ?? "processed",
      provider: "razorpay",
    };
  }

  async transferToLinkedAccount(
    input: TransferToAccountInput,
  ): Promise<TransferToAccountResult> {
    const json = await razorpayFetch<{
      id?: string;
      amount?: number;
      status?: string;
    }>("/transfers", {
      method: "POST",
      body: JSON.stringify({
        account: input.accountId,
        amount: input.amountPaise,
        currency: "INR",
        notes: input.notes ?? {},
      }),
      idempotencyKey: [
        input.accountId,
        input.notes?.settlementId ?? "",
        input.notes?.businessDate ?? "",
        String(input.amountPaise),
      ].join("|"),
    });
    if (!json.id) throw new Error("Razorpay transfer missing id");
    return {
      transferId: json.id,
      amountPaise: json.amount ?? input.amountPaise,
      status: json.status ?? "created",
      provider: "razorpay",
    };
  }
}

export function getPaymentProvider(): PaymentProvider {
  if (process.env.MOCK_PAYMENTS !== "false") {
    return new MockPaymentProvider();
  }
  return new RazorpayPaymentProvider();
}

export function isMockPayments(): boolean {
  return process.env.MOCK_PAYMENTS !== "false";
}

/** Events to enable on the Razorpay Dashboard webhook. */
export const RAZORPAY_WEBHOOK_EVENTS = [
  "payment_link.paid",
  "payment_link.expired",
  "payment_link.cancelled",
  "qr_code.credited",
  "payment.authorized",
  "payment.captured",
  "payment.failed",
  "refund.created",
  "refund.processed",
  "refund.failed",
  "transfer.processed",
  "transfer.failed",
  "settlement.processed",
  "payout.processed",
  "payout.updated",
  "payout.failed",
  "payout.reversed",
  "payout.rejected",
  "product.route.activated",
  "product.route.under_review",
  "product.route.needs_clarification",
] as const;
