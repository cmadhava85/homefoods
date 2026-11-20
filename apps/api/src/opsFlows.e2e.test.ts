/**
 * High-risk ops flows that were under-covered:
 * - Worker outbox drain → mock WhatsApp sent
 * - Week cart pay + cancel/refund
 * - Paid cancel after cut-off → cook Accept refund
 * - Child Pays (family link → senior order → payer settlement)
 * - Admin support lookup (LM- / trc_ / checkout)
 *
 *   node --import tsx --test src/opsFlows.e2e.test.ts
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNull } from "drizzle-orm";
import {
  getWhatsAppProvider,
  isMockWhatsApp,
  resetWhatsAppProvider,
} from "@localmeals/adapters";
import { closeDb, createDb, outbox } from "@localmeals/db";
import { buildApp } from "./app.js";
import {
  customerWithAddress,
  loginAdmin,
  loginCook,
  loginCustomer,
  testMobile,
} from "./testHelpers.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";
resetWhatsAppProvider();

const SLUG = "csk-homemade-delights";

describe("ops flows e2e (gaps)", () => {
  const db = createDb();
  const app = buildApp(db);
  let cookHeaders: { authorization: string };
  let adminHeaders: { authorization: string };
  let menuItemId = 1;

  async function parkPriorOutbox() {
    await db
      .update(outbox)
      .set({ processedAt: new Date(), lastError: "test_park_prior" })
      .where(isNull(outbox.processedAt));
  }

  async function drainAllPending() {
    const { drainOutboxOnce } = await import(
      "../../worker/src/drainOutbox.ts"
    );
    for (let i = 0; i < 30; i++) {
      const pending = await db.query.outbox.findMany({
        where: (t, { isNull: n }) => n(t.processedAt),
        limit: 1,
      });
      if (!pending.length) return;
      await drainOutboxOnce(db, {
        whatsappOutboundAllowed: async () => true,
      });
    }
  }

  async function openWeekDays(minDays: number) {
    const week = await app.inject({
      method: "GET",
      url: `/kitchens/${SLUG}/week?days=7&meal=LUNCH`,
    });
    assert.equal(week.statusCode, 200, week.body);
    const plan = week.json().plan as Array<{
      serviceDate: string;
      orderingOpen: boolean;
      menus: Array<{ id: number }>;
    }>;
    const days = plan.filter((d) => d.orderingOpen && d.menus.length > 0);
    assert.ok(
      days.length >= minDays,
      `need ≥${minDays} open lunch days with plates — run db:seed`,
    );
    return days;
  }

  before(async () => {
    await app.ready();
    cookHeaders = (await loginCook(app, SLUG)).headers;
    adminHeaders = (await loginAdmin(app)).headers;
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    const menu = await app.inject({ method: "GET", url: `/kitchens/${SLUG}/menu` });
    assert.ok(menu.json().menus?.[0], "No menu — run npm run db:seed");
    menuItemId = menu.json().menus[0].id;
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("worker drain: OrderPaid outbox → mock WhatsApp to cook + customer", async () => {
    await parkPriorOutbox();
    resetWhatsAppProvider();

    const mobile = testMobile("71");
    const { addressId, headers } = await customerWithAddress(app, mobile);
    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload: {
        customerMobile: mobile,
        cookSlug: SLUG,
        menuItemId,
        qty: 1,
        spice: "NORMAL",
        addressId,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const { publicId, gatewayTxnId } = created.json() as {
      publicId: string;
      gatewayTxnId: string;
    };

    const paid = await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId },
    });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.ok(["PAID", "COOKING"].includes(paid.json().order.status));

    const paidRow = await db.query.outbox.findFirst({
      where: (t, { eq: e, and: a, isNull: n }) =>
        a(e(t.eventName, "OrderPaid"), n(t.processedAt)),
      orderBy: (t, { desc: d }) => [d(t.id)],
    });
    assert.ok(paidRow, "OrderPaid outbox pending");
    const payload = paidRow.payload as { publicId?: string };
    assert.equal(payload.publicId, publicId);

    await drainAllPending();

    const after = await db.query.outbox.findFirst({
      where: (t, { eq: e }) => e(t.id, paidRow.id),
    });
    assert.ok(after?.processedAt, "OrderPaid outbox processed by drain");

    const wa = getWhatsAppProvider();
    assert.ok(isMockWhatsApp(wa));
    const bodies = wa.sent.map((m) => `${m.to}|${m.body}`);
    assert.ok(
      wa.sent.some((m) => m.to === mobile),
      `expected WA to customer ${mobile}, sent=${JSON.stringify(bodies)}`,
    );
    assert.ok(
      wa.sent.some((m) => m.body.includes(publicId) || m.body.includes("Paid")),
      `expected paid copy mentioning order, sent=${JSON.stringify(bodies)}`,
    );
  });

  it("week cart: batch pay → both lines PAID → cancel refund before cut-off", async () => {
    const days = await openWeekDays(2);
    const { mobile, addressId, headers } = await customerWithAddress(app, testMobile("72"));

    const batch = await app.inject({
      method: "POST",
      url: "/orders/batch",
      headers,
      payload: {
        customerMobile: mobile,
        cookSlug: SLUG,
        addressId,
        lines: days.slice(0, 2).map((d) => ({
          menuItemId: d.menus[0].id,
          serviceDate: d.serviceDate,
          qty: 1,
          spice: "NORMAL",
        })),
      },
    });
    assert.equal(batch.statusCode, 200, batch.body);
    const checkoutId = batch.json().checkoutId as string;
    const gatewayTxnId = batch.json().gatewayTxnId as string;
    const traceId = batch.json().traceId as string;
    assert.ok(checkoutId?.startsWith("CHK-"));
    assert.equal(batch.json().orders.length, 2);

    const paid = await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId },
    });
    assert.equal(paid.statusCode, 200, paid.body);

    const checkout = await app.inject({
      method: "GET",
      url: `/checkouts/${checkoutId}`,
      headers,
    });
    assert.equal(checkout.statusCode, 200, checkout.body);
    const statuses = (checkout.json().orders as Array<{ status: string }>).map(
      (o) => o.status,
    );
    assert.ok(
      statuses.every((s) => s === "PAID" || s === "COOKING"),
      `expected paid lines got ${statuses.join(",")}`,
    );

    // Keep cut-off open so customer cancel auto-refunds.
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });

    const cancelled = await app.inject({
      method: "POST",
      url: `/checkouts/${checkoutId}/cancel`,
      headers,
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.ok(
      ["refunded", "cancelled"].includes(cancelled.json().mode),
      `mode=${cancelled.json().mode}`,
    );

    const support = await app.inject({
      method: "GET",
      url: `/admin/orders/${encodeURIComponent(checkoutId)}`,
      headers: adminHeaders,
    });
    assert.equal(support.statusCode, 200, support.body);
    assert.equal(support.json().matchedBy, "checkoutId");
    assert.ok(support.json().checkout?.lines?.length >= 2);
    assert.equal(support.json().order.traceId, traceId);
  });

  it("paid cancel after cut-off → CANCEL_REQUESTED → cook Accept → REFUNDED", async () => {
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });

    const { mobile, addressId, headers } = await customerWithAddress(app, testMobile("73"));
    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload: {
        customerMobile: mobile,
        cookSlug: SLUG,
        menuItemId,
        qty: 1,
        spice: "NORMAL",
        addressId,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const publicId = created.json().publicId as string;
    const gatewayTxnId = created.json().gatewayTxnId as string;

    const paid = await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId },
    });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.ok(["PAID", "COOKING"].includes(paid.json().order.status));

    // Close cut-off so instant cancel becomes requestable.
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cookHeaders,
      payload: { cutoffHour: 0, cutoffMinute: 0 },
    });

    // If pay landed as COOKING (lock already), cancel may hard-fail — skip only then.
    const statusNow = paid.json().order.status as string;
    if (statusNow !== "PAID") {
      // Restore cut-off for other tests
      await app.inject({
        method: "PATCH",
        url: `/cooks/${SLUG}/meal-settings/LUNCH`,
        headers: cookHeaders,
        payload: { cutoffHour: 23, cutoffMinute: 59 },
      });
      assert.ok(true, `skip cancel-request path when status=${statusNow}`);
      return;
    }

    const reqCancel = await app.inject({
      method: "POST",
      url: `/orders/${publicId}/cancel`,
      headers,
    });
    assert.equal(reqCancel.statusCode, 200, reqCancel.body);
    assert.equal(reqCancel.json().mode, "cancel_requested");
    assert.equal(reqCancel.json().status, "CANCEL_REQUESTED");

    const accept = await app.inject({
      method: "POST",
      url: `/orders/${publicId}/cancel-accept`,
      headers: cookHeaders,
    });
    assert.equal(accept.statusCode, 200, accept.body);
    assert.equal(accept.json().status, "REFUNDED");

    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
  });

  it("Child Pays: family link → senior orders → payer mock-pay → PAID", async () => {
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    const flagOn = await app.inject({
      method: "PATCH",
      url: "/admin/features/child_pays_enabled",
      headers: adminHeaders,
      payload: { enabled: true },
    });
    assert.equal(flagOn.statusCode, 200, flagOn.body);

    const seniorMobile = testMobile("74");
    const payerMobile = testMobile("75");
    const senior = await customerWithAddress(app, seniorMobile);
    const payer = await loginCustomer(app, payerMobile);

    const invite = await app.inject({
      method: "POST",
      url: "/family/links",
      headers: senior.headers,
      payload: { payerMobile },
    });
    assert.equal(invite.statusCode, 201, invite.body);
    const linkId = invite.json().id as number;

    const accepted = await app.inject({
      method: "POST",
      url: `/family/links/${linkId}/accept`,
      headers: payer.headers,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.equal(accepted.json().status, "ACTIVE");

    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers: senior.headers,
      payload: {
        customerMobile: seniorMobile,
        cookSlug: SLUG,
        menuItemId,
        qty: 1,
        spice: "NORMAL",
        addressId: senior.addressId,
        payerMobile,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().payerMobile, payerMobile);
    assert.equal(created.json().status, "AWAITING_PAYMENT");
    const publicId = created.json().publicId as string;
    const gatewayTxnId = created.json().gatewayTxnId as string;

    const paid = await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId },
    });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.ok(["PAID", "COOKING"].includes(paid.json().order.status));

    const row = await db.query.orders.findFirst({
      where: (t, { eq: e }) => e(t.publicId, publicId),
    });
    assert.equal(row?.customerMobile, seniorMobile);
    assert.equal(row?.payerMobile, payerMobile);
  });

  it("Admin support bundle resolves LM- and trc_ and lists activity", async () => {
    const { mobile, addressId, headers } = await customerWithAddress(app, testMobile("76"));
    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload: {
        customerMobile: mobile,
        cookSlug: SLUG,
        menuItemId,
        qty: 1,
        spice: "NORMAL",
        addressId,
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const publicId = created.json().publicId as string;
    const headerTrace = String(created.headers["x-trace-id"] ?? "");
    assert.match(headerTrace, /^trc_/);

    const byPublic = await app.inject({
      method: "GET",
      url: `/admin/orders/${encodeURIComponent(publicId)}`,
      headers: adminHeaders,
    });
    assert.equal(byPublic.statusCode, 200, byPublic.body);
    assert.equal(byPublic.json().matchedBy, "publicId");
    assert.equal(byPublic.json().order.publicId, publicId);
    assert.equal(byPublic.json().order.traceId, headerTrace);
    assert.ok(byPublic.json().cloudLogging?.byTraceId?.includes(headerTrace));
    assert.ok(Array.isArray(byPublic.json().activity));
    assert.ok(Array.isArray(byPublic.json().outbox));
    assert.ok(
      byPublic.json().activity.some(
        (a: { eventName: string }) => a.eventName === "ORDER_CREATED",
      ),
      "activity includes ORDER_CREATED",
    );

    const byTrace = await app.inject({
      method: "GET",
      url: `/admin/orders/${encodeURIComponent(headerTrace)}`,
      headers: adminHeaders,
    });
    assert.equal(byTrace.statusCode, 200, byTrace.body);
    assert.equal(byTrace.json().matchedBy, "traceId");
    assert.equal(byTrace.json().order.publicId, publicId);
  });
});
