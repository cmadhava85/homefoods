/**
 * Partner logistics (Shadowfax / Porter / HTTP gateway) — MVP-2.
 * SELF cook delivery remains default until Admin enables partner_delivery
 * and cook.deliveryType = PARTNER.
 *
 * Provider selection: see `resolveLogisticsProvider()` / docs/LOGISTICS.md
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export type PartnerShipmentStatus =
  | "CREATED"
  | "ASSIGNED"
  | "PICKED_UP"
  | "DELIVERED"
  | "FAILED";

export type PartnerShipmentInput = {
  orderPublicId: string;
  pickupAddress: string;
  dropAddress: string;
  customerMobile: string;
  cookMobile: string;
  notes?: string;
  /**
   * Durable journey id — sent as `traceId` / metadata so partner webhooks
   * can echo it for Cloud Logging correlation (same as Razorpay notes.traceId).
   */
  traceId?: string;
  /** Optional geo / amount for vendors that require them. */
  pickupLat?: number | null;
  pickupLng?: number | null;
  dropLat?: number | null;
  dropLng?: number | null;
  foodPaise?: number | null;
};

export type PartnerShipmentResult = {
  partnerShipmentId: string;
  trackingUrl?: string | null;
  status: PartnerShipmentStatus;
  raw?: unknown;
};

export interface LogisticsProvider {
  readonly name: string;
  createShipment(input: PartnerShipmentInput): Promise<PartnerShipmentResult>;
  getShipment(partnerShipmentId: string): Promise<PartnerShipmentResult>;
  /** Optional: cancel open shipment (best-effort). */
  cancelShipment?(partnerShipmentId: string): Promise<void>;
}

/** Map vendor / gateway status strings onto our enum. */
export function mapPartnerShipmentStatus(raw: unknown): PartnerShipmentStatus | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, PartnerShipmentStatus> = {
    CREATED: "CREATED",
    NEW: "CREATED",
    PENDING: "CREATED",
    REQUESTED: "CREATED",
    ASSIGNED: "ASSIGNED",
    RIDER_ASSIGNED: "ASSIGNED",
    ALLOTTED: "ASSIGNED",
    ACCEPTED: "ASSIGNED",
    PICKED_UP: "PICKED_UP",
    PICKEDUP: "PICKED_UP",
    PICKUP: "PICKED_UP",
    OUT_FOR_DELIVERY: "PICKED_UP",
    OFD: "PICKED_UP",
    IN_TRANSIT: "PICKED_UP",
    DISPATCHED: "PICKED_UP",
    DELIVERED: "DELIVERED",
    COMPLETED: "DELIVERED",
    FAILED: "FAILED",
    CANCELLED: "FAILED",
    CANCELED: "FAILED",
    RTO: "FAILED",
    UNDELIVERED: "FAILED",
    EXCEPTION: "FAILED",
  };
  return aliases[s] ?? null;
}

/** Stub — throws until a real partner adapter is enabled. */
export class UnconfiguredLogisticsProvider implements LogisticsProvider {
  readonly name = "unconfigured";

  async createShipment(): Promise<PartnerShipmentResult> {
    throw new Error(
      "Partner delivery is not configured — set MOCK_LOGISTICS=true or LOGISTICS_PROVIDER=http with LOGISTICS_API_BASE_URL.",
    );
  }

  async getShipment(): Promise<PartnerShipmentResult> {
    throw new Error("Partner delivery is not configured");
  }
}

/** Local / staging stand-in until a real vendor is contracted. */
export class MockLogisticsProvider implements LogisticsProvider {
  readonly name = "mock";
  private readonly store = new Map<string, PartnerShipmentResult>();

  async createShipment(input: PartnerShipmentInput): Promise<PartnerShipmentResult> {
    const partnerShipmentId = `shp_mock_${input.orderPublicId.slice(0, 12)}_${Date.now().toString(36)}`;
    const row: PartnerShipmentResult = {
      partnerShipmentId,
      trackingUrl: `https://localmeals.local/track/${partnerShipmentId}`,
      status: "CREATED",
    };
    this.store.set(partnerShipmentId, row);
    return row;
  }

  async getShipment(partnerShipmentId: string): Promise<PartnerShipmentResult> {
    const row = this.store.get(partnerShipmentId);
    if (!row) {
      return {
        partnerShipmentId,
        trackingUrl: null,
        status: "ASSIGNED",
      };
    }
    return row;
  }

  async cancelShipment(partnerShipmentId: string): Promise<void> {
    this.store.delete(partnerShipmentId);
  }

  /** Test helper: advance mock shipment status. */
  setStatus(partnerShipmentId: string, status: PartnerShipmentStatus) {
    const row = this.store.get(partnerShipmentId);
    if (row) this.store.set(partnerShipmentId, { ...row, status });
  }
}

export type HttpLogisticsConfig = {
  /** Display name (http | shadowfax | porter | …). */
  name: string;
  baseUrl: string;
  apiKey?: string;
  /** Extra headers (JSON object via env optional). */
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Path templates (default LocalMeals partner gateway contract).
   * `{id}` → shipment id.
   */
  createPath?: string;
  getPath?: string;
  cancelPath?: string;
};

/**
 * Generic HTTP partner gateway.
 * Expects the LocalMeals partner REST contract (see docs/LOGISTICS.md).
 * Point `baseUrl` at Shadowfax/Porter via a thin gateway, or a compatible API.
 */
export class HttpLogisticsProvider implements LogisticsProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly createPath: string;
  private readonly getPath: string;
  private readonly cancelPath: string;

  constructor(config: HttpLogisticsConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
    this.extraHeaders = config.extraHeaders ?? {};
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.createPath = config.createPath ?? "/v1/shipments";
    this.getPath = config.getPath ?? "/v1/shipments/{id}";
    this.cancelPath = config.cancelPath ?? "/v1/shipments/{id}/cancel";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) {
      h.Authorization = `Bearer ${this.apiKey}`;
      h["X-Api-Key"] = this.apiKey;
    }
    return h;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      if (text) {
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new Error(`Logistics ${method} ${path} returned non-JSON (${res.status})`);
        }
      }
      if (!res.ok) {
        const msg =
          (typeof json.error === "string" && json.error) ||
          (typeof json.message === "string" && json.message) ||
          `HTTP ${res.status}`;
        throw new Error(`Logistics ${method} ${path} failed: ${msg}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseResult(json: Record<string, unknown>): PartnerShipmentResult {
    const id =
      (typeof json.shipmentId === "string" && json.shipmentId) ||
      (typeof json.partnerShipmentId === "string" && json.partnerShipmentId) ||
      (typeof json.id === "string" && json.id) ||
      null;
    if (!id) throw new Error("Logistics response missing shipmentId");
    const status =
      mapPartnerShipmentStatus(json.status) ??
      mapPartnerShipmentStatus(json.state) ??
      "CREATED";
    const trackingUrl =
      (typeof json.trackingUrl === "string" && json.trackingUrl) ||
      (typeof json.tracking_url === "string" && json.tracking_url) ||
      null;
    return { partnerShipmentId: id, trackingUrl, status, raw: json };
  }

  async createShipment(input: PartnerShipmentInput): Promise<PartnerShipmentResult> {
    const traceId = input.traceId?.trim().slice(0, 40) || null;
    const payload = {
      externalOrderId: input.orderPublicId,
      pickup: {
        address: input.pickupAddress,
        contactPhone: input.cookMobile,
        lat: input.pickupLat ?? null,
        lng: input.pickupLng ?? null,
      },
      drop: {
        address: input.dropAddress,
        contactPhone: input.customerMobile,
        lat: input.dropLat ?? null,
        lng: input.dropLng ?? null,
      },
      notes: input.notes ?? null,
      amountPaise: input.foodPaise ?? null,
      ...(traceId
        ? {
            traceId,
            metadata: { traceId, orderPublicId: input.orderPublicId },
          }
        : {}),
    };
    const json = await this.request("POST", this.createPath, payload);
    return this.parseResult(json);
  }

  async getShipment(partnerShipmentId: string): Promise<PartnerShipmentResult> {
    const path = this.getPath.replace("{id}", encodeURIComponent(partnerShipmentId));
    const json = await this.request("GET", path);
    return this.parseResult(json);
  }

  async cancelShipment(partnerShipmentId: string): Promise<void> {
    const path = this.cancelPath.replace("{id}", encodeURIComponent(partnerShipmentId));
    await this.request("POST", path, { reason: "cancelled_by_platform" });
  }
}

function parseExtraHeadersFrom(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.LOGISTICS_API_EXTRA_HEADERS?.trim();
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v != null) out[k] = String(v);
    }
    return out;
  } catch {
    throw new Error("LOGISTICS_API_EXTRA_HEADERS must be valid JSON object");
  }
}

export function resolveLogisticsProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LogisticsProvider {
  const named = (env.LOGISTICS_PROVIDER ?? "").trim().toLowerCase();
  const baseUrl = (env.LOGISTICS_API_BASE_URL ?? "").trim();

  if (env.MOCK_LOGISTICS === "true" || named === "mock") {
    return new MockLogisticsProvider();
  }
  if (named === "unconfigured") {
    return new UnconfiguredLogisticsProvider();
  }

  if (baseUrl) {
    const name = named && named !== "http" ? named : "http";
    return new HttpLogisticsProvider({
      name,
      baseUrl,
      apiKey: env.LOGISTICS_API_KEY?.trim() || undefined,
      extraHeaders: parseExtraHeadersFrom(env),
      timeoutMs: Number(env.LOGISTICS_API_TIMEOUT_MS ?? 15_000) || 15_000,
      createPath: env.LOGISTICS_CREATE_PATH?.trim() || undefined,
      getPath: env.LOGISTICS_GET_PATH?.trim() || undefined,
      cancelPath: env.LOGISTICS_CANCEL_PATH?.trim() || undefined,
    });
  }

  if (env.MOCK_LOGISTICS === "false" || env.NODE_ENV === "production") {
    return new UnconfiguredLogisticsProvider();
  }
  return new MockLogisticsProvider();
}

let logisticsProvider: LogisticsProvider = resolveLogisticsProviderFromEnv();

export function getLogisticsProvider(): LogisticsProvider {
  return logisticsProvider;
}

export function setLogisticsProvider(provider: LogisticsProvider) {
  logisticsProvider = provider;
}

export function resetLogisticsProvider() {
  logisticsProvider = resolveLogisticsProviderFromEnv();
}

export function isMockLogistics() {
  return getLogisticsProvider().name === "mock";
}

/** Normalized webhook body after vendor mapping. */
export type LogisticsWebhookEvent = {
  partnerShipmentId: string;
  status: PartnerShipmentStatus;
  /** Echoed from createShipment when the partner returns it. */
  traceId?: string;
  orderPublicId?: string;
};

/**
 * Accept LocalMeals-normalized or common vendor webhook shapes.
 */
export function normalizeLogisticsWebhookPayload(body: unknown): LogisticsWebhookEvent {
  if (!body || typeof body !== "object") {
    throw new Error("Invalid logistics webhook body");
  }
  const b = body as Record<string, unknown>;
  const data =
    b.data && typeof b.data === "object" ? (b.data as Record<string, unknown>) : null;
  const meta =
    b.metadata && typeof b.metadata === "object"
      ? (b.metadata as Record<string, unknown>)
      : data && data.metadata && typeof data.metadata === "object"
        ? (data.metadata as Record<string, unknown>)
        : null;

  const id =
    (typeof b.partnerShipmentId === "string" && b.partnerShipmentId) ||
    (typeof b.shipmentId === "string" && b.shipmentId) ||
    (typeof b.shipment_id === "string" && b.shipment_id) ||
    (typeof b.id === "string" && b.id) ||
    (data && typeof data.shipmentId === "string" && data.shipmentId) ||
    (data && typeof data.partnerShipmentId === "string" && data.partnerShipmentId) ||
    null;

  const statusRaw =
    b.status ?? b.event ?? b.event_type ?? b.state ?? data?.status ?? data?.event ?? null;
  const status = mapPartnerShipmentStatus(statusRaw);
  if (!id || id.length < 4) throw new Error("Webhook missing shipment id");
  if (!status) throw new Error(`Webhook status not recognized: ${String(statusRaw)}`);

  const pickStr = (...vals: unknown[]) => {
    for (const v of vals) {
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 40);
    }
    return undefined;
  };
  const traceId = pickStr(b.traceId, data?.traceId, meta?.traceId);
  const orderPublicId = pickStr(
    b.orderPublicId,
    b.externalOrderId,
    data?.orderPublicId,
    data?.externalOrderId,
    meta?.orderPublicId,
  );

  return {
    partnerShipmentId: id,
    status,
    ...(traceId ? { traceId } : {}),
    ...(orderPublicId ? { orderPublicId } : {}),
  };
}

export type LogisticsWebhookAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Shared-secret header and/or HMAC-SHA256 of raw body (`X-Logistics-Signature`).
 */
export function verifyLogisticsWebhookAuth(input: {
  headers: Record<string, unknown>;
  rawBody: string;
  nodeEnv?: string;
}): LogisticsWebhookAuthResult {
  const nodeEnv = input.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const secret = process.env.LOGISTICS_WEBHOOK_SECRET?.trim();
  const hmacSecret =
    process.env.LOGISTICS_WEBHOOK_HMAC_SECRET?.trim() || secret || "";

  const headerSecret = String(
    input.headers["x-logistics-secret"] ?? input.headers["X-Logistics-Secret"] ?? "",
  );
  const signature = String(
    input.headers["x-logistics-signature"] ??
      input.headers["X-Logistics-Signature"] ??
      "",
  ).replace(/^sha256=/i, "");

  if (!secret && !process.env.LOGISTICS_WEBHOOK_HMAC_SECRET?.trim()) {
    if (nodeEnv === "production") {
      return { ok: false, status: 503, error: "LOGISTICS_WEBHOOK_SECRET not configured" };
    }
    return { ok: true };
  }

  if (secret && headerSecret) {
    const a = Buffer.from(headerSecret);
    const b = Buffer.from(secret);
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
  }

  if (hmacSecret && signature) {
    const expected = createHmac("sha256", hmacSecret).update(input.rawBody).digest("hex");
    try {
      const a = Buffer.from(signature, "hex");
      const b = Buffer.from(expected, "hex");
      if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true };
    } catch {
      /* fall through */
    }
  }

  return { ok: false, status: 401, error: "Invalid logistics webhook signature" };
}
