/**
 * Admin-editable platform fee + cook commission: new orders snapshot the live values,
 * a per-cook override beats the default, and EOD pays food minus the snapshotted commission.
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { cookProfiles, createDb, closeDb, cutoffLocks, orders, settlements } from "@localmeals/db";
import { commissionPaise, lineFoodNetPaise, serviceDateISO } from "@localmeals/domain";
import { buildApp } from "./app.js";
import { customerWithAddress, loginAdmin, loginCook, testMobile } from "./testHelpers.js";
import { setFeatureFlag } from "./services/featureFlags.js";
import { getPlatformPricing, setPlatformPricing } from "./services/platformSettings.js";
import { markOrderPaid } from "./services/orders.js";
import { runEodSettlement } from "./services/settlement.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

const SLUG = "csk-homemade-delights";

describe("admin pricing: platform fee + cook commission", () => {
  const db = createDb();
  const app = buildApp(db);
  let admin: { headers: { authorization: string } };
  let cook: typeof cookProfiles.$inferSelect;
  let menuItemId = 0;
  let original: Awaited<ReturnType<typeof getPlatformPricing>>;

  async function place() {
    const c = await customerWithAddress(app, testMobile("83"));
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: c.headers,
      payload: { customerMobile: c.mobile, cookSlug: SLUG, menuItemId, qty: 2, spice: "NORMAL", addressId: c.addressId },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as typeof orders.$inferSelect;
  }

  before(async () => {
    await app.ready();
    original = await getPlatformPricing(db);
    admin = await loginAdmin(app);
    const cookHeaders = (await loginCook(app, SLUG)).headers;
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    cook = (await db.query.cookProfiles.findFirst({ where: eq(cookProfiles.slugHandle, SLUG) }))!;
    await db.delete(cutoffLocks).where(eq(cutoffLocks.serviceDate, serviceDateISO()));
    await db.update(cookProfiles).set({ maxDailyCapacity: 100_000 }).where(eq(cookProfiles.id, cook.id));
    menuItemId = (await app.inject({ method: "GET", url: `/kitchens/${SLUG}/menu` })).json().menus[0].id;
    await setFeatureFlag(db, { key: "eod_settlement_enabled", enabled: true, actor: "test" });
  });

  after(async () => {
    await setPlatformPricing(db, { ...original, actor: "test" });
    await db
      .update(cookProfiles)
      .set({ maxDailyCapacity: cook.maxDailyCapacity, commissionBps: cook.commissionBps })
      .where(eq(cookProfiles.id, cook.id));
    await app.close();
    await closeDb(db);
  });

  it("admin sets fee + commission; public pricing and new orders pick them up", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/pricing",
      headers: admin.headers,
      payload: { platformFeePaise: 1500, cookCommissionBps: 800 },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().platformFeePaise, 1500);
    assert.equal(res.json().cookCommissionBps, 800);

    const meta = await app.inject({ method: "GET", url: "/meta/features" });
    assert.equal(meta.json().pricing.platformFeePaise, 1500);

    await db.update(cookProfiles).set({ commissionBps: null }).where(eq(cookProfiles.id, cook.id));
    const o = await place();
    assert.equal(o.platformFeePaise, 1500);
    assert.equal(o.commissionBps, 800);
  });

  it("rejects values above the guard rail", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/pricing",
      headers: admin.headers,
      payload: { cookCommissionBps: 1001 },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal((await getPlatformPricing(db)).cookCommissionBps, 800);
  });

  it("per-cook override wins; null restores the default", async () => {
    const set = await app.inject({
      method: "POST",
      url: `/admin/cooks/${cook.id}/commission`,
      headers: admin.headers,
      payload: { commissionBps: 0 },
    });
    assert.equal(set.statusCode, 200, set.body);
    assert.equal(set.json().commissionBps, 0);
    assert.equal((await place()).commissionBps, 0);

    const clear = await app.inject({
      method: "POST",
      url: `/admin/cooks/${cook.id}/commission`,
      headers: admin.headers,
      payload: { commissionBps: null },
    });
    assert.equal(clear.statusCode, 200, clear.body);
    assert.equal((await place()).commissionBps, 800);
  });

  it("EOD deducts the commission snapshotted on the order, not the current rate", async () => {
    const o = await place();
    await markOrderPaid(db, { gatewayTxnId: o.gatewayTxnId!, paymentId: `pay_${o.publicId}` });
    // Rate changes after the order must not touch it.
    await setPlatformPricing(db, { cookCommissionBps: 200, actor: "test" });

    const date = serviceDateISO();
    await runEodSettlement(db, date); // flush other delivered lines for this cook/day
    const before = await db.query.settlements.findFirst({
      where: (t, { and: a, eq: e }) => a(e(t.cookId, cook.id), e(t.businessDate, date)),
    });
    await db.update(orders).set({ status: "DELIVERED", settlementHold: false }).where(eq(orders.id, o.id));
    await runEodSettlement(db, date);

    const settled = (await db.query.orders.findFirst({ where: eq(orders.id, o.id) }))!;
    assert.ok(settled.settlementId, "order settled");
    const row = (await db.query.settlements.findFirst({ where: eq(settlements.id, settled.settlementId!) }))!;
    const food = lineFoodNetPaise(o);
    const fee = commissionPaise(food, 800);
    assert.ok(fee > 0);
    assert.equal(row.grossPaise - (before?.grossPaise ?? 0), food);
    assert.equal(row.feesPaise - (before?.feesPaise ?? 0), fee);
  });
});
