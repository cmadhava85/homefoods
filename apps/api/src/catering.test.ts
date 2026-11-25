/**
 * MVP-3 party / bulk catering: flag gate, MOQ / notice / capacity, advance → balance → complete,
 * idempotent captures, cancellation refunds and late-capture auto-refund.
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  cateringBookings,
  cateringPayments,
  closeDb,
  cookCateringSettings,
  cookProfiles,
  createDb,
  outbox,
} from "@localmeals/db";
import { addDaysISO, serviceDateISO } from "@localmeals/domain";
import { buildApp } from "./app.js";
import { customerWithAddress, loginAdmin, loginCook } from "./testHelpers.js";
import { setFeatureFlag } from "./services/featureFlags.js";

process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

const SLUG = "csk-homemade-delights";
type Headers = { authorization: string };

describe("catering (MVP-3)", () => {
  const db = createDb();
  const app = buildApp(db);
  let cookHeaders: Headers;
  let adminHeaders: Headers;
  let cook: typeof cookProfiles.$inferSelect;
  let comboId = 0;
  // Random far date so reruns against the same DB don't collide on per-date capacity.
  const eventDate = () => addDaysISO(serviceDateISO(), 10 + Math.floor(Math.random() * 45));

  /** A date with no party bookings for this kitchen yet (reruns share the DB). */
  async function freeDate() {
    const used = new Set(
      (await db.query.cateringBookings.findMany({ where: eq(cateringBookings.cookId, cook.id) })).map((b) => b.eventDate),
    );
    for (let d = 5; d <= 60; d++) {
      const iso = addDaysISO(serviceDateISO(), d);
      if (!used.has(iso)) return iso;
    }
    throw new Error("no free test date");
  }

  const book = (h: Headers, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/catering/bookings", headers: h, payload: { slug: SLUG, comboId, ...payload } });

  async function payLink(publicId: string, phase: "ADVANCE" | "BALANCE") {
    const b = (await db.query.cateringBookings.findFirst({ where: eq(cateringBookings.publicId, publicId) }))!;
    const rows = await db.query.cateringPayments.findMany({
      where: and(eq(cateringPayments.bookingId, b.id), eq(cateringPayments.phase, phase)),
    });
    return rows.at(-1)!;
  }

  const capture = (p: typeof cateringPayments.$inferSelect, publicId: string) =>
    app.inject({
      method: "POST",
      url: "/webhooks/payments",
      payload: {
        event: "payment_link.paid",
        payload: {
          payment_link: {
            entity: {
              id: p.gatewayTxnId,
              amount_paid: p.amountPaise,
              reference_id: `${publicId}-X`,
              notes: { orderPublicId: publicId, kind: "CATERING" },
            },
          },
          payment: { entity: { id: `pay_${p.id}_${Date.now()}` } },
        },
      },
    });

  before(async () => {
    await app.ready();
    cookHeaders = (await loginCook(app, SLUG)).headers;
    adminHeaders = (await loginAdmin(app)).headers;
    cook = (await db.query.cookProfiles.findFirst({ where: eq(cookProfiles.slugHandle, SLUG) }))!;
    await db
      .update(cookProfiles)
      .set({ onboardingStatus: "LIVE", isActive: true, offerCookDelivery: true })
      .where(eq(cookProfiles.id, cook.id));
    await setFeatureFlag(db, { key: "catering_enabled", enabled: false, actor: "test" });
  });

  after(async () => {
    await setFeatureFlag(db, { key: "catering_enabled", enabled: false, actor: "test" });
    await db.delete(cookCateringSettings).where(eq(cookCateringSettings.cookId, cook.id));
    await db
      .update(cookProfiles)
      .set({ onboardingStatus: cook.onboardingStatus, isActive: cook.isActive, offerCookDelivery: cook.offerCookDelivery })
      .where(eq(cookProfiles.id, cook.id));
    await app.close();
    await closeDb(db);
  });

  it("everything new stays closed while catering_enabled is off (default)", async () => {
    const c = await customerWithAddress(app);
    assert.equal((await app.inject({ method: "GET", url: `/kitchens/${SLUG}/catering` })).statusCode, 404);
    const b = await book(c.headers, { comboId: 1, plates: 20, eventDate: eventDate(), eventTime: "12:00", addressId: c.addressId });
    assert.equal(b.statusCode, 404, b.body);
    const s = await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/catering/settings`,
      headers: cookHeaders,
      payload: { enabled: true },
    });
    assert.equal(s.statusCode, 404, s.body);
    const desk = await app.inject({ method: "GET", url: `/cooks/${SLUG}/catering`, headers: cookHeaders });
    assert.equal(desk.statusCode, 200, desk.body);
    assert.equal(desk.json().platformEnabled, false);
  });

  it("books with MOQ / notice checks, then advance → balance → complete", async () => {
    await setFeatureFlag(db, { key: "catering_enabled", enabled: true, actor: "test" });
    const s = await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/catering/settings`,
      headers: cookHeaders,
      payload: { enabled: true, cutoffHours: 48, dailyPlateCap: 100 },
    });
    assert.equal(s.statusCode, 200, s.body);
    const combo = await app.inject({
      method: "POST",
      url: `/cooks/${SLUG}/catering/combos`,
      headers: cookHeaders,
      payload: { name: `Seemantham Feast ${Date.now()}`, contents: "Rice, sambar, 2 poriyal, payasam", pricePerPlatePaise: 20_000, minPlates: 20, maxPlates: 80 },
    });
    assert.equal(combo.statusCode, 200, combo.body);
    comboId = combo.json().combo.id;

    const pub = await app.inject({ method: "GET", url: `/kitchens/${SLUG}/catering` });
    assert.equal(pub.statusCode, 200, pub.body);
    assert.ok(pub.json().combos.some((x: { id: number }) => x.id === comboId));
    const fee = pub.json().platformFeePaise as number;

    const c = await customerWithAddress(app);
    const date = eventDate();
    const base = { eventDate: date, eventTime: "12:00", addressId: c.addressId, note: "Seemantham at home" };
    assert.equal((await book(c.headers, { ...base, plates: 19 })).statusCode, 400);
    const soon = await book(c.headers, { ...base, plates: 20, eventDate: addDaysISO(serviceDateISO(), 1) });
    assert.equal(soon.statusCode, 400, soon.body);
    assert.match(soon.json().error, /48 hours/);

    const idempotencyKey = `test-${Date.now()}-a`;
    const res = await book(c.headers, { ...base, plates: 25, idempotencyKey });
    assert.equal(res.statusCode, 200, res.body);
    const booking = res.json().booking;
    assert.equal(booking.status, "AWAITING_ADVANCE");
    assert.equal(booking.foodPaise, 500_000);
    assert.equal(booking.advancePaise, 250_000 + fee);
    assert.equal(booking.balancePaise, 250_000);
    assert.equal(booking.duePhase, "ADVANCE");
    assert.match(booking.paymentUrl, new RegExp(`/catering/bookings/${booking.publicId}\\?txn=mock_txn_${booking.publicId}-A1`));

    // Cook must not see the address / mobile of an unpaid hold.
    const deskBefore = (await app.inject({ method: "GET", url: `/cooks/${SLUG}/catering`, headers: cookHeaders })).json();
    const held = deskBefore.bookings.find((x: { publicId: string }) => x.publicId === booking.publicId);
    assert.equal(held.deliveryAddress, null);
    assert.equal(held.customerMobile, null);

    const advance = await payLink(booking.publicId, "ADVANCE");
    for (let i = 0; i < 2; i++) {
      const hook = await capture(advance, booking.publicId);
      assert.equal(hook.statusCode, 200, hook.body);
    }
    const afterAdvance = (await db.query.cateringBookings.findFirst({ where: eq(cateringBookings.publicId, booking.publicId) }))!;
    assert.equal(afterAdvance.status, "ADVANCE_PAID");
    const notified = await db.query.outbox.findMany({ where: eq(outbox.eventName, "CateringAdvancePaid") });
    assert.equal(notified.filter((r) => (r.payload as { publicId?: string }).publicId === booking.publicId).length, 1);

    const early = await app.inject({
      method: "POST",
      url: `/cooks/${SLUG}/catering/bookings/${booking.publicId}/complete`,
      headers: cookHeaders,
    });
    assert.equal(early.statusCode, 409, early.body);

    const pay = await app.inject({ method: "POST", url: `/catering/bookings/${booking.publicId}/pay`, headers: c.headers });
    assert.equal(pay.statusCode, 200, pay.body);
    assert.equal(pay.json().phase, "BALANCE");
    assert.equal(pay.json().amountPaise, 250_000);

    // Return-URL confirm re-checks the link with the (mock) gateway.
    const confirm = await app.inject({ method: "POST", url: `/catering/bookings/${booking.publicId}/confirm`, headers: c.headers });
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.equal(confirm.json().booking.status, "PAID");
    assert.equal(confirm.json().booking.paidPaise, 500_000 + fee);

    const done = await app.inject({
      method: "POST",
      url: `/cooks/${SLUG}/catering/bookings/${booking.publicId}/complete`,
      headers: cookHeaders,
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().booking.status, "COMPLETED");

    const paidOut = await app.inject({
      method: "POST",
      url: `/admin/catering/bookings/${booking.publicId}/cook-paid`,
      headers: adminHeaders,
      payload: { utr: "UTR123456" },
    });
    assert.equal(paidOut.statusCode, 200, paidOut.body);
    assert.equal(paidOut.json().booking.cookPaidUtr, "UTR123456");

    // Same idempotency key → same booking, no second hold.
    const again = await book(c.headers, { ...base, plates: 25, idempotencyKey });
    assert.equal(again.json().booking.publicId, booking.publicId);
  });

  it("caps party plates per kitchen per date, counting live unpaid holds", async () => {
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/catering/settings`,
      headers: cookHeaders,
      payload: { dailyPlateCap: 30 },
    });
    try {
      const date = await freeDate();
      const a = await customerWithAddress(app);
      const b = await customerWithAddress(app);
      const first = await book(a.headers, { plates: 20, eventDate: date, eventTime: "19:00", addressId: a.addressId });
      assert.equal(first.statusCode, 200, first.body);
      const full = await book(b.headers, { plates: 20, eventDate: date, eventTime: "19:00", addressId: b.addressId });
      assert.equal(full.statusCode, 409, full.body);
      assert.match(full.json().error, /only 10 more/);
    } finally {
      await app.inject({
        method: "PATCH",
        url: `/cooks/${SLUG}/catering/settings`,
        headers: cookHeaders,
        payload: { dailyPlateCap: 100 },
      });
    }
  });

  it("customer cancel refunds the advance; a capture after cancel is auto-refunded", async () => {
    const c = await customerWithAddress(app);
    const paid = (await book(c.headers, { plates: 20, eventDate: eventDate(), eventTime: "11:00", addressId: c.addressId })).json().booking;
    await capture(await payLink(paid.publicId, "ADVANCE"), paid.publicId);
    const cancel = await app.inject({
      method: "POST",
      url: `/catering/bookings/${paid.publicId}/cancel`,
      headers: c.headers,
      payload: { reason: "Function postponed" },
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(cancel.json().booking.status, "CANCELLED");
    assert.equal(cancel.json().refundedPaise, paid.advancePaise);

    const held = (await book(c.headers, { plates: 20, eventDate: eventDate(), eventTime: "11:00", addressId: c.addressId })).json().booking;
    const link = await payLink(held.publicId, "ADVANCE");
    const free = await app.inject({ method: "POST", url: `/catering/bookings/${held.publicId}/cancel`, headers: c.headers, payload: {} });
    assert.equal(free.json().refundedPaise, 0);
    const late = await capture(link, held.publicId);
    assert.equal(late.statusCode, 200, late.body);
    const row = (await db.query.cateringBookings.findFirst({ where: eq(cateringBookings.publicId, held.publicId) }))!;
    assert.equal(row.status, "CANCELLED");
    assert.equal(row.refundedPaise, held.advancePaise);
  });
});
