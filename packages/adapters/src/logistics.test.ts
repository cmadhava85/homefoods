import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  MockLogisticsProvider,
  HttpLogisticsProvider,
  setLogisticsProvider,
  getLogisticsProvider,
  resetLogisticsProvider,
  resolveLogisticsProviderFromEnv,
  mapPartnerShipmentStatus,
  normalizeLogisticsWebhookPayload,
  verifyLogisticsWebhookAuth,
} from "./logistics.js";

describe("mock logistics provider", () => {
  beforeEach(() => {
    setLogisticsProvider(new MockLogisticsProvider());
  });

  it("creates a shipment id and tracking url", async () => {
    const logistics = getLogisticsProvider();
    const created = await logistics.createShipment({
      orderPublicId: "LM-TEST123",
      pickupAddress: "Kitchen",
      dropAddress: "Tower 1",
      customerMobile: "+919840111111",
      cookMobile: "+919840222222",
    });
    assert.match(created.partnerShipmentId, /^shp_mock_/);
    assert.equal(created.status, "CREATED");
    assert.ok(created.trackingUrl);

    const got = await logistics.getShipment(created.partnerShipmentId);
    assert.equal(got.partnerShipmentId, created.partnerShipmentId);
  });

  it("reset restores default provider", () => {
    resetLogisticsProvider();
    assert.ok(["mock", "unconfigured", "http"].includes(getLogisticsProvider().name));
  });
});

describe("mapPartnerShipmentStatus", () => {
  it("maps common aliases", () => {
    assert.equal(mapPartnerShipmentStatus("rider_assigned"), "ASSIGNED");
    assert.equal(mapPartnerShipmentStatus("out-for-delivery"), "PICKED_UP");
    assert.equal(mapPartnerShipmentStatus("COMPLETED"), "DELIVERED");
    assert.equal(mapPartnerShipmentStatus("RTO"), "FAILED");
    assert.equal(mapPartnerShipmentStatus("nope"), null);
  });
});

describe("normalizeLogisticsWebhookPayload", () => {
  it("accepts LocalMeals shape", () => {
    assert.deepEqual(
      normalizeLogisticsWebhookPayload({
        partnerShipmentId: "shp_1234",
        status: "ASSIGNED",
      }),
      { partnerShipmentId: "shp_1234", status: "ASSIGNED" },
    );
  });

  it("accepts vendor aliases", () => {
    assert.deepEqual(
      normalizeLogisticsWebhookPayload({
        shipment_id: "SF-9999",
        event: "picked_up",
      }),
      { partnerShipmentId: "SF-9999", status: "PICKED_UP" },
    );
  });
});

describe("verifyLogisticsWebhookAuth", () => {
  const prevSecret = process.env.LOGISTICS_WEBHOOK_SECRET;
  const prevHmac = process.env.LOGISTICS_WEBHOOK_HMAC_SECRET;

  afterEach(() => {
    if (prevSecret === undefined) delete process.env.LOGISTICS_WEBHOOK_SECRET;
    else process.env.LOGISTICS_WEBHOOK_SECRET = prevSecret;
    if (prevHmac === undefined) delete process.env.LOGISTICS_WEBHOOK_HMAC_SECRET;
    else process.env.LOGISTICS_WEBHOOK_HMAC_SECRET = prevHmac;
  });

  it("allows missing secret outside production", () => {
    delete process.env.LOGISTICS_WEBHOOK_SECRET;
    delete process.env.LOGISTICS_WEBHOOK_HMAC_SECRET;
    const r = verifyLogisticsWebhookAuth({
      headers: {},
      rawBody: "{}",
      nodeEnv: "development",
    });
    assert.equal(r.ok, true);
  });

  it("accepts shared secret header", () => {
    process.env.LOGISTICS_WEBHOOK_SECRET = "s3cret";
    const r = verifyLogisticsWebhookAuth({
      headers: { "x-logistics-secret": "s3cret" },
      rawBody: "{}",
      nodeEnv: "production",
    });
    assert.equal(r.ok, true);
  });

  it("accepts hmac signature", () => {
    process.env.LOGISTICS_WEBHOOK_HMAC_SECRET = "hmac-key";
    delete process.env.LOGISTICS_WEBHOOK_SECRET;
    const rawBody = '{"shipmentId":"shp_1","status":"ASSIGNED"}';
    const sig = createHmac("sha256", "hmac-key").update(rawBody).digest("hex");
    const r = verifyLogisticsWebhookAuth({
      headers: { "x-logistics-signature": sig },
      rawBody,
      nodeEnv: "production",
    });
    assert.equal(r.ok, true);
  });
});

describe("resolveLogisticsProviderFromEnv", () => {
  it("uses mock when MOCK_LOGISTICS=true", () => {
    const p = resolveLogisticsProviderFromEnv({ MOCK_LOGISTICS: "true" } as NodeJS.ProcessEnv);
    assert.equal(p.name, "mock");
  });

  it("uses http when base url set", () => {
    const p = resolveLogisticsProviderFromEnv({
      MOCK_LOGISTICS: "false",
      LOGISTICS_PROVIDER: "shadowfax",
      LOGISTICS_API_BASE_URL: "https://logistics.example.com",
      LOGISTICS_API_KEY: "k",
    } as NodeJS.ProcessEnv);
    assert.equal(p.name, "shadowfax");
    assert.ok(p instanceof HttpLogisticsProvider);
  });

  it("uses unconfigured in production without base url", () => {
    const p = resolveLogisticsProviderFromEnv({
      NODE_ENV: "production",
      MOCK_LOGISTICS: "false",
    } as NodeJS.ProcessEnv);
    assert.equal(p.name, "unconfigured");
  });
});

describe("HttpLogisticsProvider", () => {
  it("POSTs create shipment to gateway contract", async () => {
    const calls: { url: string; method: string; body: string | null }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(
        JSON.stringify({
          shipmentId: "shp_http_1",
          status: "CREATED",
          trackingUrl: "https://track.example/shp_http_1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const p = new HttpLogisticsProvider({
        name: "http",
        baseUrl: "https://gateway.example",
        apiKey: "key",
      });
      const created = await p.createShipment({
        orderPublicId: "LM-1",
        pickupAddress: "A",
        dropAddress: "B",
        customerMobile: "+9191",
        cookMobile: "+9192",
        notes: "1× Rice",
      });
      assert.equal(created.partnerShipmentId, "shp_http_1");
      assert.equal(created.trackingUrl, "https://track.example/shp_http_1");
      assert.equal(calls[0]?.method, "POST");
      assert.match(calls[0]?.url ?? "", /\/v1\/shipments$/);
      assert.match(calls[0]?.body ?? "", /externalOrderId/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
