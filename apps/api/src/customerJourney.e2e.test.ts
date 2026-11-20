/**
 * Customer food-ordering journey + observability checks (traceId / correlation).
 *
 * Mock (default for CI): MOCK_PAYMENTS=true → synthetic capture payload.
 * Live Razorpay test keys: MOCK_PAYMENTS=false in .env → creates real plink_,
 * then posts an HMAC-signed payment_link.paid webhook (Razorpay cannot reach localhost).
 *
 *   MOCK_PAYMENTS=false node --import tsx --test src/customerJourney.e2e.test.ts
 */
import "dotenv/config";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import pino from "pino";
import { eq } from "drizzle-orm";
import { closeDb, createDb, outbox } from "@localmeals/db";
import { CORR_PAYLOAD_KEY, fastifyLoggerOptions } from "@localmeals/observability";
import { isMockPayments as paymentsAreMock } from "@localmeals/adapters";
import { buildApp } from "./app.js";
import { customerWithAddress, loginCook, testMobile } from "./testHelpers.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";
// Honor .env / shell for payments — do not force mock here.
const LIVE_PAYMENTS = process.env.MOCK_PAYMENTS === "false";

type LogLine = Record<string, unknown>;

function signRazorpayWebhook(rawBody: string): string {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET?.trim();
  assert.ok(secret, "RAZORPAY_WEBHOOK_SECRET required when MOCK_PAYMENTS=false");
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

describe("customer ordering journey + logs", () => {
  const logLines: LogLine[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString().trim();
      if (text) {
        try {
          logLines.push(JSON.parse(text) as LogLine);
        } catch {
          /* ignore non-json */
        }
      }
      cb();
    },
  });
  const logger = pino(fastifyLoggerOptions("localmeals-api-e2e"), dest);

  const db = createDb();
  const app = buildApp(db, { loggerInstance: logger });
  let cookHeaders: { authorization: string };
  let menuItemId = 1;

  before(async () => {
    await app.ready();
    if (LIVE_PAYMENTS) {
      assert.ok(process.env.RAZORPAY_KEY_ID?.startsWith("rzp_"), "RAZORPAY_KEY_ID");
      assert.ok(process.env.RAZORPAY_KEY_SECRET, "RAZORPAY_KEY_SECRET");
      assert.equal(paymentsAreMock(), false, "expected live Razorpay provider");
    }
    cookHeaders = (await loginCook(app, "csk-homemade-delights")).headers;
    await app.inject({
      method: "PATCH",
      url: "/cooks/csk-homemade-delights/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    assert.ok(menu.json().menus?.[0], "No menu for csk-homemade-delights — run npm run db:seed");
    menuItemId = menu.json().menus[0].id;
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it(
    LIVE_PAYMENTS
      ? "LIVE Razorpay: place plink_ → HMAC webhook → kitchen → deliver"
      : "MOCK: place → pay webhook → kitchen → deliver with stable traceId",
    async () => {
      logLines.length = 0;
      const mobile = testMobile("88");
      const { addressId, headers } = await customerWithAddress(app, mobile);

      const created = await app.inject({
        method: "POST",
        url: "/orders",
        headers,
        payload: {
          customerMobile: mobile,
          cookSlug: "csk-homemade-delights",
          menuItemId,
          qty: 1,
          spice: "NORMAL",
          addressId,
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const body = created.json() as {
        publicId: string;
        gatewayTxnId: string;
        traceId?: string;
        id: number;
        foodPaise?: number;
        deliveryPaise?: number;
        platformFeePaise?: number;
        qty?: number;
      };
      assert.ok(body.publicId, "publicId");
      assert.ok(body.gatewayTxnId, "gatewayTxnId");

      if (LIVE_PAYMENTS) {
        assert.match(body.gatewayTxnId, /^plink_/, "expected real Razorpay payment link id");
        assert.ok(body.paymentUrl ?? created.json().paymentUrl, "paymentUrl");
        console.log(
          "[e2e-live] created Razorpay link",
          body.gatewayTxnId,
          "traceId=",
          created.headers["x-trace-id"],
        );
      } else {
        assert.match(body.gatewayTxnId, /^mock_txn_/, "expected mock gateway id");
      }

      const headerTrace = created.headers["x-trace-id"];
      assert.ok(headerTrace, "X-Trace-Id response header");
      assert.match(String(headerTrace), /^trc_/);

      const row = await db.query.orders.findFirst({
        where: (t, { eq: e }) => e(t.publicId, body.publicId),
      });
      assert.ok(row?.traceId, "orders.trace_id persisted");
      assert.equal(String(headerTrace), row!.traceId);

      const amountPaise =
        row!.foodPaise * row!.qty -
        (row!.foodDiscountPaise ?? 0) +
        row!.deliveryPaise +
        row!.platformFeePaise;

      let paid;
      if (LIVE_PAYMENTS) {
        // Razorpay cannot POST to localhost — simulate their webhook with valid HMAC
        // using the same secret they would use (proves signature + capture path).
        const eventBody = {
          event: "payment_link.paid",
          payload: {
            payment_link: {
              entity: {
                id: body.gatewayTxnId,
                amount_paid: amountPaise,
                reference_id: body.publicId,
                notes: {
                  orderPublicId: body.publicId,
                  traceId: row!.traceId,
                },
              },
            },
            payment: {
              entity: {
                id: `pay_e2e_${Date.now()}`,
                amount: amountPaise,
                notes: {
                  orderPublicId: body.publicId,
                  traceId: row!.traceId,
                  payment_link_id: body.gatewayTxnId,
                },
              },
            },
          },
        };
        const raw = JSON.stringify(eventBody);
        const signature = signRazorpayWebhook(raw);
        paid = await app.inject({
          method: "POST",
          url: "/webhooks/payments",
          headers: {
            "content-type": "application/json",
            "x-razorpay-signature": signature,
            "x-request-id": `e2e-rzp-${Date.now()}`,
          },
          payload: raw,
        });
        console.log("[e2e-live] signed webhook status", paid.statusCode, paid.body.slice(0, 200));
      } else {
        paid = await app.inject({
          method: "POST",
          url: "/webhooks/payments",
          headers: { "x-request-id": `e2e-wh-${Date.now()}` },
          payload: { gatewayTxnId: body.gatewayTxnId, status: "captured" },
        });
      }

      assert.equal(paid.statusCode, 200, paid.body);
      const paidBody = paid.json() as {
        order?: { status: string; traceId?: string };
        traceId?: string;
        kind?: string;
      };
      assert.ok(
        ["PAID", "COOKING"].includes(paidBody.order?.status ?? ""),
        `expected PAID/COOKING got ${paidBody.order?.status} body=${paid.body}`,
      );
      const paidTrace = paid.headers["x-trace-id"] ?? paidBody.traceId ?? paidBody.order?.traceId;
      assert.equal(String(paidTrace), row!.traceId, "webhook reuses same traceId");

      await app.inject({
        method: "POST",
        url: "/internal/cutoffs/LUNCH",
        payload: { force: true },
      });
      const packed = await app.inject({
        method: "POST",
        url: "/cooks/csk-homemade-delights/pack",
        headers: cookHeaders,
      });
      assert.equal(packed.statusCode, 200, packed.body);

      const dispatched = await app.inject({
        method: "POST",
        url: "/cooks/csk-homemade-delights/dispatch",
        headers: cookHeaders,
      });
      assert.equal(dispatched.statusCode, 200, dispatched.body);

      const delivered = await app.inject({
        method: "POST",
        url: `/orders/${body.publicId}/delivered`,
        headers: cookHeaders,
      });
      assert.equal(delivered.statusCode, 200, delivered.body);
      assert.equal(delivered.json().status, "DELIVERED");

      const final = await db.query.orders.findFirst({
        where: (t, { eq: e }) => e(t.id, row!.id),
      });
      assert.equal(final?.status, "DELIVERED");
      assert.equal(final?.traceId, row!.traceId);

      const paidOutbox = await db
        .select()
        .from(outbox)
        .where(eq(outbox.eventName, "OrderPaid"))
        .orderBy(outbox.id);
      const matchingPaid = [...paidOutbox].reverse().find((o) => {
        const p = o.payload as Record<string, unknown>;
        const c = p[CORR_PAYLOAD_KEY] as { traceId?: string } | undefined;
        return c?.traceId === row!.traceId || p.traceId === row!.traceId || p.publicId === body.publicId;
      });
      assert.ok(matchingPaid, "OrderPaid outbox carries traceId");

      const withTrace = logLines.filter((l) => l.traceId === row!.traceId);
      assert.ok(
        withTrace.length >= 1,
        `expected ≥1 log line with traceId=${row!.traceId}, got ${withTrace.length}`,
      );
    },
  );
});
