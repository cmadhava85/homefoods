import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { buildApp } from "./app.js";
import { closeDb, createDb } from "@localmeals/db";
import { assertProductionConfig } from "./prodConfig.js";
import { customerWithAddress, loginCustomer, loginCook, testMobile } from "./testHelpers.js";

process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

describe("security regressions", () => {
  const db = createDb();
  const app = buildApp(db);

  before(async () => {
    await app.ready();
    await db.execute(sql`DELETE FROM rate_limit_buckets`);
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("rejects CORS for unknown browser origin", async () => {
    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        Origin: "https://evil.example",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.ok(res.statusCode >= 400 || !res.headers["access-control-allow-origin"]);
  });

  it("allows CORS for configured web origin", async () => {
    const origin = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers["access-control-allow-origin"], origin);
  });

  it("kitchen mutator requires cook/admin session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cooks/csk-homemade-delights/pack",
      payload: {},
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403);
    assert.notEqual(res.statusCode, 200);
  });

  it("logout revokes bearer so /auth/me fails", async () => {
    const { headers, token } = await loginCustomer(app, testMobile("71"));
    const me1 = await app.inject({ method: "GET", url: "/auth/me", headers });
    assert.equal(me1.statusCode, 200, me1.body);

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        ...headers,
        cookie: `lm_session=${token}`,
      },
    });
    assert.equal(logout.statusCode, 200, logout.body);

    const me2 = await app.inject({ method: "GET", url: "/auth/me", headers });
    assert.ok(me2.statusCode === 401 || me2.json()?.user == null || me2.json()?.ok === false);
    if (me2.statusCode === 200) {
      assert.equal(me2.json().user, null);
    }
  });

  it("retention endpoint rejects when INTERNAL_JOB_TOKEN set and header missing", async () => {
    const prev = process.env.INTERNAL_JOB_TOKEN;
    process.env.INTERNAL_JOB_TOKEN = "test-retention-token-security";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/ops/retention",
        payload: { mode: "purge" },
      });
      assert.ok(res.statusCode === 401 || res.statusCode === 403 || res.statusCode >= 400);
      assert.notEqual(res.statusCode, 200);
    } finally {
      if (prev === undefined) delete process.env.INTERNAL_JOB_TOKEN;
      else process.env.INTERNAL_JOB_TOKEN = prev;
    }
  });

  it("retention purge succeeds with internal token", async () => {
    const prev = process.env.INTERNAL_JOB_TOKEN;
    process.env.INTERNAL_JOB_TOKEN = "test-retention-token-ok";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/ops/retention",
        headers: { "x-internal-token": "test-retention-token-ok" },
        payload: { mode: "purge" },
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().ok, true);
      assert.ok(res.json().deleted);
    } finally {
      if (prev === undefined) delete process.env.INTERNAL_JOB_TOKEN;
      else process.env.INTERNAL_JOB_TOKEN = prev;
    }
  });

  it("rate-limit store is shared (second hit increments via Postgres)", async () => {
    const a = await app.inject({ method: "GET", url: "/health" });
    assert.equal(a.statusCode, 200);
    // /health is allow-listed — use a limited auth route instead
    const mobile = testMobile("72");
    const r1 = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { mobile, role: "CUSTOMER" },
    });
    assert.equal(r1.statusCode, 200, r1.body);
    const r2 = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { mobile, role: "CUSTOMER" },
    });
    // Still within OTP throttle window for same mobile — either 200 (mock) or 429
    assert.ok([200, 429].includes(r2.statusCode), r2.body);
  });

  it("assertProductionConfig fails closed on mock payments in production", () => {
    const snap = { ...process.env };
    try {
      process.env.NODE_ENV = "production";
      process.env.DATABASE_URL = "postgres://u:p@localhost/db";
      process.env.AUTH_SECRET = "not-the-local-default-secret-value";
      process.env.INTERNAL_JOB_TOKEN = "tok";
      process.env.WEB_ORIGIN = "https://example.com";
      process.env.MOCK_PAYMENTS = "true";
      process.env.MOCK_WHATSAPP = "false";
      process.env.MOCK_AUTH = "false";
      process.env.WHATSAPP_VERIFY_TOKEN = "v";
      process.env.WHATSAPP_APP_SECRET = "s";
      process.env.WHATSAPP_ACCESS_TOKEN = "a";
      process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
      assert.throws(() => assertProductionConfig(), /MOCK_PAYMENTS/);
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in snap)) delete process.env[k];
      }
      Object.assign(process.env, snap);
    }
  });

  it("cook session can hit kitchen route (positive control)", async () => {
    const cook = await loginCook(app, "csk-homemade-delights");
    const res = await app.inject({
      method: "GET",
      url: "/cooks/csk-homemade-delights/manifest",
      headers: cook.headers,
    });
    assert.equal(res.statusCode, 200, res.body);
  });

  it("admin routes reject unauthenticated callers (assertAuthed fail-closed)", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/tickets" });
    assert.ok(res.statusCode === 401 || res.statusCode === 403 || res.statusCode >= 400);
    assert.notEqual(res.statusCode, 200);
  });

  it("rejects anonymous POST /orders (customer session required)", async () => {
    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    assert.equal(menu.statusCode, 200, menu.body);
    const menuItemId = menu.json().menus?.[0]?.id;
    assert.ok(menuItemId, "seed menu required");
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      payload: {
        customerMobile: testMobile("70"),
        cookSlug: "csk-homemade-delights",
        menuItemId,
        qty: 1,
      },
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403 || res.statusCode >= 400);
    assert.notEqual(res.statusCode, 200);
  });

  it("rejects spoofed customerMobile from another signed-in customer", async () => {
    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    const menuItemId = menu.json().menus?.[0]?.id;
    assert.ok(menuItemId);
    const victim = testMobile("69");
    const { mobile, addressId, headers } = await customerWithAddress(app, testMobile("68"));
    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload: {
        customerMobile: victim,
        cookSlug: "csk-homemade-delights",
        menuItemId,
        qty: 1,
        addressId,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const order = await app.inject({
      method: "GET",
      url: `/orders/${created.json().publicId}`,
      headers,
    });
    assert.equal(order.statusCode, 200);
    assert.equal(order.json().customerMobile, mobile);
    assert.notEqual(order.json().customerMobile, victim);
  });

  it("rejects cancel of another customer order", async () => {
    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    const menuItemId = menu.json().menus?.[0]?.id;
    assert.ok(menuItemId);
    const owner = await customerWithAddress(app, testMobile("67"));
    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers: owner.headers,
      payload: {
        customerMobile: owner.mobile,
        cookSlug: "csk-homemade-delights",
        menuItemId,
        qty: 1,
        addressId: owner.addressId,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const other = await loginCustomer(app, testMobile("66"));
    const cancel = await app.inject({
      method: "POST",
      url: `/orders/${created.json().publicId}/cancel`,
      headers: other.headers,
    });
    assert.ok(cancel.statusCode === 401 || cancel.statusCode === 403 || cancel.statusCode >= 400);
    assert.notEqual(cancel.statusCode, 200);
  });

  it("GET /orders/:publicId redacts mobiles for anonymous callers", async () => {
    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    assert.equal(menu.statusCode, 200, menu.body);
    const menuItemId = menu.json().menus?.[0]?.id;
    assert.ok(menuItemId, "seed menu required");
    const { mobile, addressId, headers } = await customerWithAddress(app, testMobile("73"));
    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload: {
        customerMobile: mobile,
        cookSlug: "csk-homemade-delights",
        menuItemId,
        qty: 1,
        addressId,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const got = await app.inject({
      method: "GET",
      url: `/orders/${created.json().publicId}`,
    });
    assert.equal(got.statusCode, 200, got.body);
    assert.equal(got.json().customerMobile, undefined);
    assert.equal(got.json().payerMobile, undefined);
    assert.equal(got.json().deliveryTargetAddress, undefined);
    assert.equal(got.json().hasDeliveryAddress, true);
    assert.ok(got.json().publicId);
    assert.ok(got.json().status);
  });

  it("GET /kitchens never leaks cook mobile or payout fields", async () => {
    const res = await app.inject({ method: "GET", url: "/kitchens?pin=600119" });
    assert.equal(res.statusCode, 200, res.body);
    const kitchens = res.json() as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(kitchens) && kitchens.length > 0);
    for (const k of kitchens) {
      assert.equal(k.mobileNumber, undefined);
      assert.equal(k.payoutUpiId, undefined);
      assert.equal(k.payoutAccountNote, undefined);
      assert.equal(k.payoutBeneficiaryRef, undefined);
    }
    assert.doesNotMatch(res.body, /payoutUpiId|payoutAccountNote|payoutBeneficiaryRef|"mobileNumber"/);

    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    assert.equal(menu.statusCode, 200, menu.body);
    const cook = menu.json().cook as Record<string, unknown>;
    assert.ok(cook);
    assert.equal(cook.mobileNumber, undefined);
    assert.equal(cook.payoutUpiId, undefined);
    assert.equal(cook.payoutAccountNote, undefined);
    assert.equal(cook.payoutBeneficiaryRef, undefined);
  });

  it("Idempotency-Key replays the same POST /orders create", async () => {
    const week = await app.inject({
      method: "GET",
      url: "/kitchens/csk-homemade-delights/week?days=7&meal=LUNCH",
    });
    assert.equal(week.statusCode, 200, week.body);
    const day = (
      week.json().plan as Array<{
        serviceDate: string;
        menus: Array<{ id: number }>;
        orderingOpen: boolean;
      }>
    ).find((d) => d.orderingOpen && d.menus.length > 0);
    assert.ok(day, "need an open lunch day with plates — run npm run db:seed");
    const { mobile, addressId, headers } = await customerWithAddress(app, testMobile("75"));
    const key = `e2e-idem-${mobile}-${Date.now()}`;
    const payload = {
      customerMobile: mobile,
      cookSlug: "csk-homemade-delights",
      menuItemId: day.menus[0]!.id,
      qty: 1,
      addressId,
      serviceDate: day.serviceDate,
    };
    const first = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { ...headers, "idempotency-key": key },
      payload,
    });
    assert.equal(first.statusCode, 200, first.body);
    const second = await app.inject({
      method: "POST",
      url: "/orders",
      headers: { ...headers, "idempotency-key": key },
      payload,
    });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().publicId, first.json().publicId);
    assert.equal(second.json().gatewayTxnId, first.json().gatewayTxnId);
  });


  it("mock-confirm rejects non-mock gateway ids", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId: "plink_live_should_fail" },
    });
    assert.equal(res.statusCode, 400, res.body);
  });

  it("payment webhook acks unknown txn with 200 (no Razorpay retry storm)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      payload: { gatewayTxnId: "plink_does_not_exist_xyz", status: "captured" },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().ignored, true);
    assert.equal(res.json().reason, "order_not_found");
  });

  it("payment webhook rejects forged signature when live payments mode", async () => {
    const prevMock = process.env.MOCK_PAYMENTS;
    const prevSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    process.env.MOCK_PAYMENTS = "false";
    process.env.RAZORPAY_WEBHOOK_SECRET = "unit-test-webhook-secret";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/payments",
        headers: {
          "content-type": "application/json",
          "x-razorpay-signature": "0000000000000000000000000000000000000000000000000000000000000000",
        },
        payload: {
          event: "payment_link.paid",
          payload: {
            payment_link: { entity: { id: "plink_forged", amount: 10800 } },
            payment: { entity: { id: "pay_forged", amount: 10800 } },
          },
        },
      });
      assert.equal(res.statusCode, 401, res.body);
    } finally {
      if (prevMock === undefined) delete process.env.MOCK_PAYMENTS;
      else process.env.MOCK_PAYMENTS = prevMock;
      if (prevSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
      else process.env.RAZORPAY_WEBHOOK_SECRET = prevSecret;
    }
  });

  it("confirm-return rejects a paymentLinkId that does not match the order", async () => {
    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    const menuItemId = menu.json().menus?.[0]?.id;
    const { mobile, addressId, headers } = await customerWithAddress(app, testMobile("74"));
    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload: {
        customerMobile: mobile,
        cookSlug: "csk-homemade-delights",
        menuItemId,
        qty: 1,
        addressId,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const publicId = created.json().publicId as string;
    const statusBefore = created.json().status as string;
    const forge = await app.inject({
      method: "POST",
      url: "/payments/confirm-return",
      payload: {
        publicId,
        paymentLinkId: "plink_attacker_other_order",
        linkStatus: "paid",
        paymentId: "pay_forged_client",
      },
    });
    assert.equal(forge.statusCode, 400, forge.body);
    assert.match(String(forge.json().error ?? ""), /does not match/i);
    const got = await app.inject({ method: "GET", url: `/orders/${publicId}` });
    assert.equal(got.json().status, statusBefore);
  });

  it("admin settlement mark-paid rejects anonymous", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/settlements/1/manual-pay",
      payload: { utr: "HACK123" },
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403);
  });

  /** Simulate a NODE_ENV=production service (e.g. public staging) for one block. */
  async function asProduction<T>(fn: () => Promise<T>): Promise<T> {
    const prev = {
      NODE_ENV: process.env.NODE_ENV,
      AUTH_SECRET: process.env.AUTH_SECRET,
      ADMIN_MOBILES: process.env.ADMIN_MOBILES,
    };
    process.env.NODE_ENV = "production";
    process.env.AUTH_SECRET = "test-only-strong-secret-value-for-prod-mode";
    process.env.ADMIN_MOBILES = "+919900000077";
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("OTP request does not reveal whether a number is an admin or registered cook", async () => {
    await db.execute(sql`DELETE FROM rate_limit_buckets`);
    const notAdmin = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { mobile: testMobile("73"), role: "ADMIN" },
    });
    const notCook = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { mobile: testMobile("74"), role: "COOK" },
    });
    for (const res of [notAdmin, notCook]) {
      assert.equal(res.statusCode, 200, res.body);
      assert.deepEqual(Object.keys(res.json()).sort(), ["expiresInSec", "mobile", "ok", "role"]);
    }
    const stored = await db.execute(
      sql`select 1 from auth_otps where mobile_number in (${notAdmin.json().mobile}, ${notCook.json().mobile})`,
    );
    assert.equal(Array.from(stored as unknown as unknown[]).length, 0, "no code is issued for ineligible numbers");
  });

  it("mock auth on a production service never issues an ADMIN session", async () => {
    await asProduction(async () => {
      await db.execute(sql`DELETE FROM rate_limit_buckets`);
      const req = await app.inject({
        method: "POST",
        url: "/auth/otp/request",
        payload: { mobile: "+919900000077", role: "ADMIN" },
      });
      assert.equal(req.statusCode, 200, req.body);
      assert.equal(req.json().mockCode, undefined, "admin code must never be echoed");
      const ver = await app.inject({
        method: "POST",
        url: "/auth/otp/verify",
        payload: { mobile: "+919900000077", role: "ADMIN", code: "123456" },
      });
      assert.ok(ver.statusCode >= 400, `demo code minted an admin session: ${ver.body}`);
      // The well-known dev admin number is not an admin on a production service.
      const fallback = await app.inject({
        method: "POST",
        url: "/auth/otp/verify",
        payload: { mobile: "+919900000001", role: "ADMIN", code: "123456" },
      });
      assert.ok(fallback.statusCode >= 400, fallback.body);
    });
  });

  it("production login sets the HttpOnly cookie but does not return the token in the body", async () => {
    await asProduction(async () => {
      await db.execute(sql`DELETE FROM rate_limit_buckets`);
      const ver = await app.inject({
        method: "POST",
        url: "/auth/otp/verify",
        payload: { mobile: testMobile("75"), role: "CUSTOMER", code: "123456" },
      });
      assert.equal(ver.statusCode, 200, ver.body);
      assert.equal(ver.json().token, undefined);
      assert.ok(ver.json().user);
      assert.match(String(ver.headers["set-cookie"]), /lm_session=.+HttpOnly/);
    });
  });
});
