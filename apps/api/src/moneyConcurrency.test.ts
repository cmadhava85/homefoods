/**
 * Money-lifecycle + concurrency regressions from docs/CODE_REVIEW.md (R1–R13, UX-W4).
 * Runs against the real Postgres test DB (mock payments / WhatsApp).
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  adminActionLog,
  closeDb,
  cookProfiles,
  createDb,
  cutoffLocks,
  orders,
  outbox,
  payments,
  platformEventLedger,
  settlements,
  waInboundDedupe,
} from "@localmeals/db";
import {
  getWhatsAppProvider,
  MockPaymentProvider,
  resetWhatsAppProvider,
} from "@localmeals/adapters";
import { serviceDateISO } from "@localmeals/domain";
import { buildApp } from "./app.js";
import {
  acceptCancelRequest,
  declineCancelRequest,
  expireStalePaymentHolds,
  markOrderPaid,
  usedKitchenDayQty,
} from "./services/orders.js";
import { refundOrder } from "./services/admin.js";
import { runEodSettlement } from "./services/settlement.js";
import { runMealCutoff } from "./services/cookOps.js";
import { requestOtp, verifyOtp } from "./services/auth.js";
import { processWaInboundOnce } from "./services/waInboundDedupe.js";
import { getWaSession, setWaSession } from "./services/waSession.js";
import {
  clearRateLimitBuckets,
  customerWithAddress,
  loginAdmin,
  loginCook,
  testMobile,
} from "./testHelpers.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";
resetWhatsAppProvider();

type Order = typeof orders.$inferSelect;
const SLUG = "csk-homemade-delights";
const COOK_MOBILE = "+919876543210";
const MINUTE = 60_000;

const lineTotal = (o: Order) =>
  Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0)) + o.deliveryPaise + o.platformFeePaise;

describe("money lifecycle + concurrency regressions", () => {
  const db = createDb();
  const app = buildApp(db);
  let menuItemId = 0;
  let cookId = "";
  let originalCapacity = 40;
  let cookHeaders: { authorization: string };
  let adminHeaders: { authorization: string };

  async function placeOrder(): Promise<Order> {
    const c = await customerWithAddress(app, testMobile("83"));
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: c.headers,
      payload: { customerMobile: c.mobile, cookSlug: SLUG, menuItemId, qty: 1, spice: "NORMAL", addressId: c.addressId },
    });
    assert.equal(res.statusCode, 200, res.body);
    return (await db.query.orders.findFirst({ where: eq(orders.id, res.json().id) }))!;
  }

  async function paidOrder(): Promise<Order> {
    const o = await placeOrder();
    await markOrderPaid(db, { gatewayTxnId: o.gatewayTxnId!, paymentId: `pay_${o.publicId}` });
    return (await db.query.orders.findFirst({ where: eq(orders.id, o.id) }))!;
  }

  async function reload(id: number) {
    return (await db.query.orders.findFirst({ where: eq(orders.id, id) }))!;
  }

  /** Clone a real order row as an extra week-cart line (same customer/cook/charge). */
  async function cloneLine(base: Order, patch: Partial<Order>): Promise<Order> {
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = base;
    const [row] = await db
      .insert(orders)
      .values({
        ...rest,
        publicId: `LM-T${Math.random().toString(16).slice(2, 11).toUpperCase()}`,
        idempotencyKey: null,
        ...patch,
      })
      .returning();
    return row;
  }

  async function refundRows(orderId: number) {
    return db
      .select()
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.kind, "REFUND")));
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
    const cook = (await db.query.cookProfiles.findFirst({ where: eq(cookProfiles.slugHandle, SLUG) }))!;
    cookId = cook.id;
    originalCapacity = cook.maxDailyCapacity;
    await db.update(cookProfiles).set({ maxDailyCapacity: 1000 }).where(eq(cookProfiles.id, cookId));
    // Earlier suites may have locked today's lunch — keep paid orders PAID here.
    await db
      .delete(cutoffLocks)
      .where(and(eq(cutoffLocks.cookId, cookId), eq(cutoffLocks.serviceDate, serviceDateISO())));
    const menu = await app.inject({ method: "GET", url: `/kitchens/${SLUG}/menu` });
    menuItemId = menu.json().menus[0].id;
  });

  after(async () => {
    await db
      .update(cookProfiles)
      .set({ maxDailyCapacity: originalCapacity })
      .where(eq(cookProfiles.id, cookId));
    await app.close();
    await closeDb(db);
  });

  it("R6: a failed payment-link call releases the order instead of leaving a stuck hold", async () => {
    const realCreate = MockPaymentProvider.prototype.createPayment;
    MockPaymentProvider.prototype.createPayment = async () => {
      throw new Error("gateway timeout");
    };
    const c = await customerWithAddress(app, testMobile("84"));
    const payload = { customerMobile: c.mobile, cookSlug: SLUG, menuItemId, qty: 1, spice: "NORMAL", addressId: c.addressId };
    try {
      const res = await app.inject({ method: "POST", url: "/orders", headers: c.headers, payload });
      assert.equal(res.statusCode, 502, res.body);
    } finally {
      MockPaymentProvider.prototype.createPayment = realCreate;
    }
    const rows = await db.query.orders.findMany({ where: eq(orders.customerMobile, c.mobile) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "CANCELLED");
    assert.equal(rows[0].idempotencyKey, null);

    // Same request again (same deterministic key) gets a fresh, payable order.
    const retry = await app.inject({ method: "POST", url: "/orders", headers: c.headers, payload });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.ok(retry.json().paymentUrl);
  });

  it("R1: the unpaid hold outlives the 20-minute payment link", async () => {
    const o = await placeOrder();
    await db.update(orders).set({ updatedAt: new Date(Date.now() - 21 * MINUTE) }).where(eq(orders.id, o.id));
    await expireStalePaymentHolds(db);
    assert.equal((await reload(o.id)).status, "AWAITING_PAYMENT", "hold expired while the link is still payable");

    await db.update(orders).set({ updatedAt: new Date(Date.now() - 26 * MINUTE) }).where(eq(orders.id, o.id));
    await expireStalePaymentHolds(db);
    assert.equal((await reload(o.id)).status, "CANCELLED");
  });

  it("R9: paid-after-expiry is auto-refunded exactly once across duplicate webhooks", async () => {
    const o = await placeOrder();
    const amount = lineTotal(o);
    await db.update(orders).set({ updatedAt: new Date(Date.now() - 30 * MINUTE) }).where(eq(orders.id, o.id));
    await expireStalePaymentHolds(db);
    assert.equal((await reload(o.id)).status, "CANCELLED");

    const capture = { orderPublicId: o.publicId, paymentId: `pay_late_${o.id}`, paidAmountPaise: amount };
    await Promise.all([markOrderPaid(db, capture), markOrderPaid(db, capture)]); // link.paid + captured
    await markOrderPaid(db, capture); // gateway retry

    const refunds = (await refundRows(o.id)).filter((p) => p.idempotencyKey?.startsWith("term_"));
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].status, "REFUNDED");
    assert.equal(refunds[0].amountPaise, amount);
    const notices = await db
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        sql`${outbox.eventName} = 'OrderRefunded' and ${outbox.payload}->>'publicId' = ${o.publicId}`,
      );
    assert.equal(notices.length, 1, "customer must get one refund message, not one per webhook");
    assert.equal((await reload(o.id)).status, "CANCELLED", "a cancelled order is never resurrected");
  });

  it("R9: a late duplicate capture on an already-refunded order does not refund again", async () => {
    const o = await paidOrder();
    await refundOrder(db, { orderId: o.id, mode: "FULL", reason: "test refund" });
    await markOrderPaid(db, { gatewayTxnId: o.gatewayTxnId!, paymentId: `pay_${o.publicId}` });
    const refunds = await refundRows(o.id);
    assert.equal(refunds.length, 1);
    assert.ok(!refunds[0].idempotencyKey?.startsWith("term_"));
  });

  it("R9: a checkout paid in full refunds only the line that was already cancelled", async () => {
    const a = await placeOrder();
    const checkoutId = `CHK-T${Date.now().toString(16).toUpperCase()}`.slice(0, 20);
    await db.update(orders).set({ checkoutId }).where(eq(orders.id, a.id));
    const b = await cloneLine({ ...a, checkoutId }, { status: "CANCELLED", serviceDate: a.serviceDate });
    const total = lineTotal(a) + lineTotal(b);

    await markOrderPaid(db, { gatewayTxnId: a.gatewayTxnId!, paymentId: `pay_mixed_${a.id}`, paidAmountPaise: total });

    assert.equal((await reload(a.id)).status, "PAID");
    assert.equal((await reload(b.id)).status, "CANCELLED");
    const refunds = (await refundRows(b.id)).filter((p) => p.idempotencyKey?.startsWith("term_"));
    assert.equal(refunds.length, 1);
    assert.equal(refunds[0].amountPaise, lineTotal(b));
  });

  it("R10: FAILED→PAID recovery when the kitchen filled up cancels + refunds instead of 4xx", async () => {
    const o = await placeOrder();
    await db.update(orders).set({ status: "FAILED" }).where(eq(orders.id, o.id));
    const used = await usedKitchenDayQty(db, cookId, o.serviceDate);
    await db.update(cookProfiles).set({ maxDailyCapacity: used }).where(eq(cookProfiles.id, cookId));
    try {
      await markOrderPaid(db, { gatewayTxnId: o.gatewayTxnId!, paymentId: `pay_full_${o.id}` });
    } finally {
      await db.update(cookProfiles).set({ maxDailyCapacity: 1000 }).where(eq(cookProfiles.id, cookId));
    }
    assert.equal((await reload(o.id)).status, "CANCELLED");
    const refunds = (await refundRows(o.id)).filter((p) => p.idempotencyKey?.startsWith("term_"));
    assert.equal(refunds.length, 1);
    const ledger = await db
      .select({ id: platformEventLedger.id })
      .from(platformEventLedger)
      .where(and(eq(platformEventLedger.orderId, o.id), eq(platformEventLedger.eventName, "PAID_OVER_CAPACITY")));
    assert.equal(ledger.length, 1);
  });

  it("R8: a stale PENDING refund claim is re-claimed and finalized; a fresh one is not double-sent", async () => {
    const stale = await paidOrder();
    await db.insert(payments).values({
      orderId: stale.id,
      kind: "REFUND",
      amountPaise: lineTotal(stale),
      status: "PENDING",
      gatewayTxnId: "pending_crash",
      idempotencyKey: `lm_${stale.id}_FULL`,
      createdAt: new Date(Date.now() - 11 * MINUTE),
    });
    const done = await refundOrder(db, { orderId: stale.id, mode: "FULL", reason: "retry after crash" });
    assert.equal(done.status, "REFUNDED");
    assert.equal((await refundRows(stale.id))[0].status, "REFUNDED");

    const fresh = await paidOrder();
    await db.insert(payments).values({
      orderId: fresh.id,
      kind: "REFUND",
      amountPaise: lineTotal(fresh),
      status: "PENDING",
      gatewayTxnId: "pending_inflight",
      idempotencyKey: `lm_${fresh.id}_FULL`,
    });
    const inFlight = await refundOrder(db, { orderId: fresh.id, mode: "FULL", reason: "double click" });
    assert.notEqual(inFlight.status, "REFUNDED", "an in-flight claim must not be refunded twice");
  });

  it("R12: concurrent cook Accept/Decline on a cancel request leaves a consistent result", async () => {
    for (let i = 0; i < 3; i++) {
      const o = await paidOrder();
      await db.update(orders).set({ status: "CANCEL_REQUESTED" }).where(eq(orders.id, o.id));
      await Promise.allSettled([acceptCancelRequest(db, o.publicId), declineCancelRequest(db, o.publicId)]);
      const final = await reload(o.id);
      const refunds = await refundRows(o.id);
      const refunded = final.status === "REFUNDED" && refunds.length === 1;
      const declined = ["PAID", "COOKING"].includes(final.status) && refunds.length === 0;
      assert.ok(refunded || declined, `inconsistent: status ${final.status}, refunds ${refunds.length}`);
    }

    const o = await paidOrder();
    await db.update(orders).set({ status: "CANCEL_REQUESTED" }).where(eq(orders.id, o.id));
    await acceptCancelRequest(db, o.publicId);
    await assert.rejects(declineCancelRequest(db, o.publicId));
    assert.equal((await reload(o.id)).status, "REFUNDED");
  });

  it("R11b: week-cart fee/discount rebalance skips CANCEL_REQUESTED siblings", async () => {
    const base = await paidOrder();
    const checkoutId = `CHK-CR${Date.now().toString(16).toUpperCase()}`.slice(0, 20);
    const disc = Math.floor((base.foodPaise * base.qty * 10) / 100);
    const days = ["2031-04-01", "2031-04-02", "2031-04-03"];
    await db
      .update(orders)
      .set({
        checkoutId,
        serviceDate: days[0],
        foodDiscountPaise: disc,
        weekDiscountPercent: 10,
        platformFeePaise: 700,
      })
      .where(eq(orders.id, base.id));
    const first = await reload(base.id);
    const pendingCancel = await cloneLine(first, {
      serviceDate: days[1],
      platformFeePaise: 0,
      status: "CANCEL_REQUESTED",
    });
    const stable = await cloneLine(first, { serviceDate: days[2], platformFeePaise: 0 });

    const prevMinDays = (await db.query.cookProfiles.findFirst({ where: eq(cookProfiles.id, cookId) }))!
      .weekDiscountMinDays;
    await db.update(cookProfiles).set({ weekDiscountMinDays: 3 }).where(eq(cookProfiles.id, cookId));
    try {
      await refundOrder(db, {
        orderId: first.id,
        mode: "FULL",
        reason: "customer cancel",
        rebalanceCheckout: true,
      });
      assert.equal(
        (await reload(pendingCancel.id)).platformFeePaise,
        0,
        "fee must not park on a cancel-pending sibling",
      );
      assert.equal(
        (await reload(pendingCancel.id)).foodDiscountPaise,
        disc,
        "cancel-pending sibling keeps its week discount until that cancel resolves",
      );
      assert.equal((await reload(stable.id)).platformFeePaise, 700, "fee moves to the stable paid day");
      assert.equal((await reload(stable.id)).foodDiscountPaise, 0, "stable day loses discount when below minDays");
    } finally {
      await db.update(cookProfiles).set({ weekDiscountMinDays: prevMinDays }).where(eq(cookProfiles.id, cookId));
    }
  });

  it("R11: week-cart cancels count calendar days, move the ₹7 fee, and never under/over-refund", async () => {
    const base = await paidOrder();
    const checkoutId = `CHK-W${Date.now().toString(16).toUpperCase()}`.slice(0, 20);
    const disc = Math.floor((base.foodPaise * base.qty * 10) / 100);
    const days = ["2031-03-03", "2031-03-04", "2031-03-05"];
    await db
      .update(orders)
      .set({ checkoutId, serviceDate: days[0], foodDiscountPaise: disc, weekDiscountPercent: 10, platformFeePaise: 700 })
      .where(eq(orders.id, base.id));
    const first = await reload(base.id);
    const d2 = await cloneLine(first, { serviceDate: days[1], platformFeePaise: 0 });
    const d3Lunch = await cloneLine(first, { serviceDate: days[2], platformFeePaise: 0 });
    const d3Dinner = await cloneLine(first, { serviceDate: days[2], mealType: "DINNER", platformFeePaise: 0 });
    const lines = [first, d2, d3Lunch, d3Dinner];
    const totalPaid = lines.reduce((n, o) => n + lineTotal(o), 0);

    const prevMinDays = (await db.query.cookProfiles.findFirst({ where: eq(cookProfiles.id, cookId) }))!
      .weekDiscountMinDays;
    await db.update(cookProfiles).set({ weekDiscountMinDays: 3 }).where(eq(cookProfiles.id, cookId));
    try {
      // 4 lines remain 3 lines but only 2 calendar days → below minDays=3 → discount clawed back.
      await refundOrder(db, { orderId: first.id, mode: "FULL", reason: "customer cancel", rebalanceCheckout: true });
      const [r1] = await refundRows(first.id);
      assert.equal(
        r1.amountPaise,
        first.foodPaise * first.qty - 4 * disc + first.deliveryPaise,
        "day-1 refund excludes the ₹7 fee and the clawed-back discount",
      );
      assert.equal((await reload(d2.id)).platformFeePaise, 700, "₹7 fee moved to the next remaining day");
      assert.equal((await reload(d2.id)).foodDiscountPaise, 0);

      // Cancel the rest one by one — the customer must get back exactly what they paid in total.
      for (const line of [d2, d3Lunch, d3Dinner]) {
        await refundOrder(db, { orderId: line.id, mode: "FULL", reason: "customer cancel", rebalanceCheckout: true });
      }
      const refunded = (
        await db
          .select({ amount: payments.amountPaise })
          .from(payments)
          .where(and(inArray(payments.orderId, lines.map((l) => l.id)), eq(payments.kind, "REFUND")))
      ).reduce((n, r) => n + r.amount, 0);
      assert.equal(refunded, totalPaid);
    } finally {
      await db.update(cookProfiles).set({ weekDiscountMinDays: prevMinDays }).where(eq(cookProfiles.id, cookId));
    }
  });

  it("R7: concurrent EOD runs settle each order once; a later run appends to the same batch", async () => {
    const date = `2019-${String((Date.now() % 12) + 1).padStart(2, "0")}-${String((Date.now() % 27) + 1).padStart(2, "0")}`;
    await db.delete(settlements).where(and(eq(settlements.cookId, cookId), eq(settlements.businessDate, date)));
    const template = await paidOrder();
    const delivered = { status: "DELIVERED" as const, serviceDate: date, settlementHold: false, settlementId: null, checkoutId: null };
    const first = [await cloneLine(template, delivered), await cloneLine(template, delivered)];

    await Promise.all([runEodSettlement(db, date), runEodSettlement(db, date), runEodSettlement(db, date)]);

    const foodNet = (o: Order) => Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0));
    let rows = await db.select().from(settlements).where(and(eq(settlements.cookId, cookId), eq(settlements.businessDate, date)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orderCount, 2);
    assert.equal(rows[0].grossPaise, first.reduce((n, o) => n + foodNet(o), 0));
    for (const o of first) assert.equal((await reload(o.id)).settlementId, rows[0].id);

    const late = await cloneLine(template, delivered); // dinner delivered after the first run
    await runEodSettlement(db, date);
    rows = await db.select().from(settlements).where(and(eq(settlements.cookId, cookId), eq(settlements.businessDate, date)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orderCount, 3);
    assert.equal(rows[0].grossPaise, [...first, late].reduce((n, o) => n + foodNet(o), 0));
  });

  it("R5: admin actions are audited with the signed-in admin's mobile", async () => {
    const o = await paidOrder();
    const res = await app.inject({
      method: "POST",
      url: "/internal/ops/refunds",
      headers: adminHeaders,
      payload: { orderId: o.id, mode: "FULL", reason: "admin audit test" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const [log] = await db
      .select()
      .from(adminActionLog)
      .where(and(eq(adminActionLog.entityId, String(o.id)), like(adminActionLog.action, "REFUND_%")));
    assert.equal(log.actor, "+919900000001");
  });

  it("R4: a failed inbound handler releases the wamid so Meta's redelivery is processed", async () => {
    const wamid = `wamid.test.${Date.now()}`;
    const from = "+919800000001";
    await assert.rejects(
      processWaInboundOnce(db, { wamid, from }, async () => {
        throw new Error("handler crashed");
      }),
    );
    const retry = await processWaInboundOnce(db, { wamid, from }, async () => "handled");
    assert.deepEqual(retry, { duplicate: false, result: "handled" });
    const dup = await processWaInboundOnce(db, { wamid, from }, async () => "again");
    assert.deepEqual(dup, { duplicate: true });
    await db.delete(waInboundDedupe).where(eq(waInboundDedupe.wamid, wamid));
  });

  it("R13: OTP attempts are reserved before comparing, and a code is single-use", async () => {
    process.env.MOCK_AUTH = "false";
    const wa = getWhatsAppProvider() as unknown as { sent: Array<{ to: string; body: string }> };
    const codeFor = (mobile: string) =>
      [...wa.sent].reverse().find((m) => m.to === mobile)?.body.match(/(\d{6})/)?.[1] ?? "";
    try {
      await clearRateLimitBuckets();
      const mobile = testMobile("85");
      await requestOtp(db, { mobile, role: "CUSTOMER" });
      const code = codeFor(mobile);
      const wrong = code === "000000" ? "111111" : "000000";
      for (let i = 0; i < 4; i++) {
        await assert.rejects(verifyOtp(db, { mobile, role: "CUSTOMER", code: wrong }), /Invalid OTP/);
      }
      // 5th attempt (the last allowed) still works with the right code.
      const ok = await verifyOtp(db, { mobile, role: "CUSTOMER", code });
      assert.ok(ok.token);

      const mobile2 = testMobile("86");
      await requestOtp(db, { mobile: mobile2, role: "CUSTOMER" });
      const code2 = codeFor(mobile2);
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => verifyOtp(db, { mobile: mobile2, role: "CUSTOMER", code: code2 })),
      );
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "an OTP must be usable once");

      const mobile3 = testMobile("87");
      await requestOtp(db, { mobile: mobile3, role: "CUSTOMER" });
      for (let i = 0; i < 5; i++) {
        await assert.rejects(verifyOtp(db, { mobile: mobile3, role: "CUSTOMER", code: wrong }));
      }
      await assert.rejects(
        verifyOtp(db, { mobile: mobile3, role: "CUSTOMER", code: codeFor(mobile3) }),
        /request a new code|expired/i,
      );
    } finally {
      process.env.MOCK_AUTH = "true";
    }
  });

  it("UX-W4: checkout guard lets address steps through and its Cancel order button clears the cart", async () => {
    const from = testMobile("88");
    const send = async (text: string) => {
      const res = await app.inject({ method: "POST", url: "/webhooks/whatsapp", payload: { from, text } });
      assert.equal(res.statusCode, 200, res.body);
      return res.json() as { intent?: string };
    };
    const startCheckout = () =>
      setWaSession(db, from, "PICK_ITEM", { cookSlug: SLUG, kitchenName: "CSK", items: [] });

    await startCheckout();
    assert.equal((await send("Orders")).intent, "SESSION_GUARD");

    // The bot's own browse commands continue the flow instead of tripping the guard.
    await startCheckout();
    assert.equal((await send(`Menu ${SLUG}`)).intent, "MENU");

    await startCheckout();
    assert.equal((await send("Save HOME Guard Tower 3, Flat 7")).intent, "SAVE_ADDRESS");

    await startCheckout();
    assert.equal((await send("Cancel order")).intent, "SESSION_CLEARED");
    assert.equal(await getWaSession(db, from), null);
    assert.equal((await send("Orders")).intent, "ORDERS", "no guard once the cart is cleared");
  });

  it("R2: repeated cut-off ticks message the cook once; force re-sends", async () => {
    const wa = getWhatsAppProvider() as unknown as { sent: Array<{ to: string; body: string }> };
    const lockedMsgs = () => wa.sent.filter((m) => m.to === COOK_MOBILE && /locked/i.test(m.body)).length;
    await db
      .delete(cutoffLocks)
      .where(and(eq(cutoffLocks.cookId, cookId), eq(cutoffLocks.serviceDate, serviceDateISO()), eq(cutoffLocks.mealType, "LUNCH")));
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cookHeaders,
      payload: { cutoffHour: 0, cutoffMinute: 0 },
    });
    try {
      const before = lockedMsgs();
      await runMealCutoff(db, "LUNCH", { cookId });
      await runMealCutoff(db, "LUNCH", { cookId });
      await runMealCutoff(db, "LUNCH", { cookId });
      assert.equal(lockedMsgs() - before, 1, "15-minute ticks must not re-send the lock manifest");
      await runMealCutoff(db, "LUNCH", { cookId, force: true });
      assert.equal(lockedMsgs() - before, 2);
    } finally {
      await app.inject({
        method: "PATCH",
        url: `/cooks/${SLUG}/meal-settings/LUNCH`,
        headers: cookHeaders,
        payload: { cutoffHour: 23, cutoffMinute: 59 },
      });
      await db
        .delete(cutoffLocks)
        .where(and(eq(cutoffLocks.cookId, cookId), eq(cutoffLocks.serviceDate, serviceDateISO())));
    }
  });
  it("LOAD-1: re-ordering after cancelling (no Idempotency-Key header) gets a fresh order + payment", async () => {
    const c = await customerWithAddress(app, testMobile("84"));
    const single = { customerMobile: c.mobile, cookSlug: SLUG, menuItemId, qty: 1, spice: "NORMAL", addressId: c.addressId };
    const batch = {
      customerMobile: c.mobile,
      cookSlug: SLUG,
      addressId: c.addressId,
      lines: [{ menuItemId, serviceDate: serviceDateISO(), qty: 1, spice: "NORMAL" }],
    };

    for (const [url, payload, cancel] of [
      ["/orders", single, (b: { publicId: string }) => `/orders/${b.publicId}/cancel`],
      ["/orders/batch", batch, (b: { checkoutId: string }) => `/checkouts/${b.checkoutId}/cancel`],
    ] as const) {
      const first = await app.inject({ method: "POST", url, headers: c.headers, payload });
      assert.equal(first.statusCode, 200, first.body);
      const cancelled = await app.inject({
        method: "POST",
        url: (cancel as (b: never) => string)(first.json() as never),
        headers: c.headers,
      });
      assert.equal(cancelled.statusCode, 200, cancelled.body);

      const again = await app.inject({ method: "POST", url, headers: c.headers, payload });
      assert.equal(again.statusCode, 200, `${url}: ${again.body}`);
      assert.notEqual(again.json().gatewayTxnId, first.json().gatewayTxnId, `${url} must get a new payment link`);
      const newLines = (again.json().orders ?? [again.json()]) as Array<{ id: number }>;
      for (const line of newLines) {
        const o = await reload(line.id);
        assert.equal(o.status, "AWAITING_PAYMENT");
        assert.ok(o.gatewayTxnId, `${url}: re-order must be linked to its payment (no orphan hold)`);
      }
      // Clean up the hold.
      await app.inject({
        method: "POST",
        url: (cancel as (b: never) => string)(again.json() as never),
        headers: c.headers,
      });
    }
  });
});
