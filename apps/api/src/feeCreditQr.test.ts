/**
 * Cost-saving payment features: convenience fee, wallet credit (refund-to-credit, spend, holds),
 * fully credit-paid checkouts (no gateway), and pickup UPI QR.
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { cookProfiles, createDb, closeDb, customerCredits, cutoffLocks, dailyMenus, outbox, payments, orders } from "@localmeals/db";
import { convenienceFeePaise, GATEWAY_FEE_BPS, lineTotalPaise, serviceDateISO } from "@localmeals/domain";
import { buildApp } from "./app.js";
import { customerWithAddress, loginCook, testMobile } from "./testHelpers.js";
import { setFeatureFlag } from "./services/featureFlags.js";
import { markOrderPaid } from "./services/orders.js";
import { addCredit, creditBalancePaise, lockCustomerCredit } from "./services/credits.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

const SLUG = "csk-homemade-delights";

describe("convenience fee + wallet credit + pickup QR", () => {
  const db = createDb();
  const app = buildApp(db);
  let menuItemId = 0;
  let cook: typeof cookProfiles.$inferSelect;

  async function place(c: { headers: { authorization: string }; mobile: string; addressId: number }, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: c.headers,
      payload: { customerMobile: c.mobile, cookSlug: SLUG, menuItemId, qty: 1, spice: "NORMAL", addressId: c.addressId, ...extra },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as typeof orders.$inferSelect & { paymentUrl?: string; qrImageUrl?: string | null };
  }
  const reload = async (id: number) => (await db.query.orders.findFirst({ where: eq(orders.id, id) }))!;
  const balance = async (c: { headers: { authorization: string } }) =>
    (await app.inject({ method: "GET", url: "/me/credits", headers: c.headers })).json().balancePaise as number;

  before(async () => {
    await app.ready();
    const cookHeaders = (await loginCook(app, SLUG)).headers;
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    cook = (await db.query.cookProfiles.findFirst({ where: eq(cookProfiles.slugHandle, SLUG) }))!;
    // Paid orders must stay PAID (cancellable) — clear any cut-off lock other suites left for today.
    await db.delete(cutoffLocks).where(eq(cutoffLocks.serviceDate, serviceDateISO()));
    await db.update(cookProfiles).set({ maxDailyCapacity: 100_000 }).where(eq(cookProfiles.id, cook.id));
    const menu = await app.inject({ method: "GET", url: `/kitchens/${SLUG}/menu` });
    menuItemId = menu.json().menus[0].id;
    await setFeatureFlag(db, { key: "wallet_credit_enabled", enabled: true, actor: "test" });
  });

  after(async () => {
    await setFeatureFlag(db, { key: "convenience_fee_enabled", enabled: false, actor: "test" });
    await setFeatureFlag(db, { key: "pickup_enabled", enabled: false, actor: "test" });
    await db
      .update(cookProfiles)
      .set({ maxDailyCapacity: cook.maxDailyCapacity, pickupEnabled: cook.pickupEnabled, pickupLandmark: cook.pickupLandmark })
      .where(eq(cookProfiles.id, cook.id));
    await app.close();
    await closeDb(db);
  });

  it("fee on: line carries the grossed-up fee, the link charges it, and a short capture is rejected", async () => {
    await setFeatureFlag(db, { key: "convenience_fee_enabled", enabled: true, actor: "test" });
    try {
      const c = await customerWithAddress(app, testMobile("85"));
      const o = await place(c);
      const base = lineTotalPaise({ ...o, convenienceFeePaise: 0 });
      assert.equal(o.convenienceFeePaise, convenienceFeePaise(base, GATEWAY_FEE_BPS.LINK));
      assert.ok(o.convenienceFeePaise > 0);
      const charge = await db.query.payments.findFirst({ where: and(eq(payments.orderId, o.id), eq(payments.kind, "CHARGE")) });
      assert.equal(charge!.amountPaise, base + o.convenienceFeePaise);
      await assert.rejects(markOrderPaid(db, { gatewayTxnId: o.gatewayTxnId!, paidAmountPaise: base }), /does not match/);
      await markOrderPaid(db, { gatewayTxnId: o.gatewayTxnId!, paidAmountPaise: base + o.convenienceFeePaise });
      assert.equal((await reload(o.id)).status, "PAID");
    } finally {
      await setFeatureFlag(db, { key: "convenience_fee_enabled", enabled: false, actor: "test" });
    }
  });

  it("refund-to-credit is instant (no gateway refund) and the credit pays the next order outright", async () => {
    const c = await customerWithAddress(app, testMobile("86"));
    const first = await place(c);
    await markOrderPaid(db, { gatewayTxnId: first.gatewayTxnId!, paymentId: `pay_${first.publicId}` });

    const cancel = await app.inject({
      method: "POST",
      url: `/orders/${first.publicId}/cancel`,
      headers: c.headers,
      payload: { refundTo: "CREDIT" },
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal((await reload(first.id)).status, "REFUNDED");
    const refund = await db.query.payments.findFirst({ where: and(eq(payments.orderId, first.id), eq(payments.kind, "REFUND")) });
    assert.equal((refund!.rawPayload as { gatewayPaise: number }).gatewayPaise, 0);
    assert.equal(refund!.status, "REFUNDED");
    const total = lineTotalPaise(first);
    assert.equal(await balance(c), total);

    // Same plate again → credit covers it: PAID immediately, no gateway, no "pay here" message.
    const second = await place(c);
    assert.equal(second.paymentMethod, "CREDIT");
    assert.equal(second.creditAppliedPaise, total);
    assert.equal(second.status, "PAID");
    const prompts = await db.select().from(outbox).where(eq(outbox.eventName, "OrderCreated"));
    assert.equal(prompts.some((r) => (r.payload as { publicId?: string }).publicId === second.publicId), false);
    assert.equal(await balance(c), 0);
    const ledger = await db.select().from(customerCredits).where(eq(customerCredits.customerMobile, c.mobile));
    assert.deepEqual(ledger.map((l) => l.amountPaise).sort((a, b) => a - b), [-total, total]);

    // Cancelling the credit-paid order returns it to credit even with the default refund target.
    const back = await app.inject({ method: "POST", url: `/orders/${second.publicId}/cancel`, headers: c.headers, payload: {} });
    assert.equal(back.statusCode, 200, back.body);
    assert.equal(await balance(c), total);
  });

  it("unpaid orders hold credit; cancelling them releases it; parallel checkouts cannot double-spend", async () => {
    const c = await customerWithAddress(app, testMobile("87"));
    await addCredit(db, { mobile: c.mobile, amountPaise: 3000, reason: "TEST", key: `test_${c.mobile}` });

    const held = await place(c);
    assert.equal(held.creditAppliedPaise, 3000);
    assert.equal(held.paymentMethod, "LINK");
    const charge = await db.query.payments.findFirst({ where: and(eq(payments.orderId, held.id), eq(payments.kind, "CHARGE")) });
    assert.equal(charge!.amountPaise, lineTotalPaise(held) - 3000);
    assert.equal(await balance(c), 0, "held by the unpaid order");

    const cancel = await app.inject({ method: "POST", url: `/orders/${held.publicId}/cancel`, headers: c.headers });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(await balance(c), 3000, "released when the unpaid order is cancelled");

    // Two kitchens, so the per-kitchen capacity lock does not serialise them — only the credit lock does.
    const other = (await db.query.cookProfiles.findFirst({ where: eq(cookProfiles.slugHandle, "amma-priya") }))!;
    const src = (await db.query.dailyMenus.findFirst({ where: eq(dailyMenus.id, menuItemId) }))!;
    const { id: _id, ...menuCopy } = src;
    const [otherMenu] = await db.insert(dailyMenus).values({ ...menuCopy, cookId: other.id }).returning();
    await app.inject({
      method: "PATCH",
      url: "/cooks/amma-priya/meal-settings/LUNCH",
      headers: (await loginCook(app, "amma-priya")).headers,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    try {
      const [a, b] = await Promise.all([
        place(c),
        place(c, { cookSlug: "amma-priya", menuItemId: otherMenu.id }),
      ]);
      assert.equal(a.creditAppliedPaise + b.creditAppliedPaise, 3000);
    } finally {
      await db.update(dailyMenus).set({ isAvailable: false }).where(eq(dailyMenus.id, otherMenu.id));
    }
    assert.equal(await creditBalancePaise(db, c.mobile), 0);
  });

  it("the per-customer credit lock serialises concurrent checkouts", async () => {
    const mobile = testMobile("90");
    let releasedAt = 0;
    const first = db.transaction(async (tx) => {
      await lockCustomerCredit(tx, mobile);
      await new Promise((r) => setTimeout(r, 300));
      releasedAt = Date.now();
    });
    await new Promise((r) => setTimeout(r, 50));
    let acquiredAt = 0;
    await db.transaction(async (tx) => {
      await lockCustomerCredit(tx, mobile);
      acquiredAt = Date.now();
    });
    await first;
    assert.ok(acquiredAt >= releasedAt, "second checkout must wait for the first to commit");
    // A different customer is not blocked.
    await db.transaction((tx) => lockCustomerCredit(tx, testMobile("91")));
  });

  it("account deletion is blocked while credit remains", async () => {
    const c = await customerWithAddress(app, testMobile("88"));
    await addCredit(db, { mobile: c.mobile, amountPaise: 500, reason: "TEST", key: `test_${c.mobile}` });
    const res = await app.inject({ method: "POST", url: "/me/account/delete", headers: c.headers, payload: { confirm: "DELETE" } });
    assert.equal(res.statusCode, 409, res.body);
    assert.match(res.json().error, /credit/i);
  });

  it("pickup can pay by UPI QR (lower fee); the QR capture marks it paid; delivery ignores UPI_QR", async () => {
    await setFeatureFlag(db, { key: "pickup_enabled", enabled: true, actor: "test" });
    await setFeatureFlag(db, { key: "convenience_fee_enabled", enabled: true, actor: "test" });
    await db.update(cookProfiles).set({ pickupEnabled: true, pickupLandmark: "Gate 2, Temple St" }).where(eq(cookProfiles.id, cook.id));
    try {
      const c = await customerWithAddress(app, testMobile("89"));
      const qr = await place(c, { fulfillmentMode: "PICKUP", paymentMethod: "UPI_QR", addressId: null });
      assert.equal(qr.paymentMethod, "UPI_QR");
      assert.match(qr.gatewayTxnId!, /^mock_qr_/);
      assert.ok(qr.qrImageUrl);
      const base = lineTotalPaise({ ...qr, convenienceFeePaise: 0 });
      assert.equal(qr.convenienceFeePaise, convenienceFeePaise(base, GATEWAY_FEE_BPS.UPI_QR));

      const view = await app.inject({ method: "GET", url: `/orders/${qr.publicId}`, headers: c.headers });
      assert.equal(view.json().qrImageUrl, qr.qrImageUrl);

      const hook = await app.inject({ method: "POST", url: "/webhooks/payments", payload: { gatewayTxnId: qr.gatewayTxnId, status: "captured" } });
      assert.ok(hook.statusCode < 300, hook.body);
      assert.equal((await reload(qr.id)).status, "PAID");

      const delivery = await place(c, { paymentMethod: "UPI_QR" });
      assert.equal(delivery.paymentMethod, "LINK", "QR is pickup-only");
    } finally {
      await setFeatureFlag(db, { key: "convenience_fee_enabled", enabled: false, actor: "test" });
    }
  });
});
