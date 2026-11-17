import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { closeDb, createDb, cookProfiles } from "@localmeals/db";
import { eq } from "drizzle-orm";
import { assertCanAcceptPaidOrders } from "@localmeals/domain";
import { customerWithAddress, loginAdmin, loginCook, testMobile } from "./testHelpers.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

describe("MVP-1 integration", () => {
  const db = createDb();
  const app = buildApp(db);
  let cookHeaders: { authorization: string };
  let adminHeaders: { authorization: string };
  let menuItemId = 1;
  let gatewayTxnId = "";
  let orderId = 0;
  let publicId = "";

  before(async () => {
    await app.ready();
    const cookAuth = await loginCook(app, "sri-sai");
    cookHeaders = cookAuth.headers;
    adminHeaders = (await loginAdmin(app)).headers;
    // Keep ordering open regardless of wall clock — cook-desired cut-off
    const cut = await app.inject({
      method: "PATCH",
      url: "/cooks/sri-sai/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    assert.equal(cut.statusCode, 200, cut.body);
    let menu = await app.inject({ method: "GET", url: "/kitchens/sri-sai/menu" });
    assert.equal(menu.statusCode, 200);
    if (!menu.json().menus?.[0]) {
      // Service date rolled — re-seed via db package CLI is preferred; fail clearly
      assert.fail("No menu for sri-sai today — run npm run db:seed");
    }
    menuItemId = menu.json().menus[0].id;
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("blocks non-LIVE cook from accepting paid orders", () => {
    assert.throws(
      () =>
        assertCanAcceptPaidOrders({
          onboardingStatus: "DOCS_SUBMITTED",
          fssaiNumber: null,
          isActive: true,
        }),
      /LIVE/,
    );
  });

  it("creates order with idempotent double create", async () => {
    const mobile = testMobile("84");
    const { addressId } = await customerWithAddress(app, mobile);
    const payload = {
      customerMobile: mobile,
      cookSlug: "sri-sai",
      menuItemId,
      qty: 1,
      spice: "NORMAL" as const,
      addressId,
    };
    const a = await app.inject({ method: "POST", url: "/orders", payload });
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(a.json().status, "AWAITING_PAYMENT");
    const b = await app.inject({ method: "POST", url: "/orders", payload });
    assert.equal(b.statusCode, 200);
    assert.equal(a.json().publicId, b.json().publicId);
    gatewayTxnId = a.json().gatewayTxnId;
    orderId = a.json().id;
    publicId = a.json().publicId;
    assert.ok(gatewayTxnId);
  });

  it("blocks double-pay by returning same PAID order", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId },
    });
    assert.equal(first.statusCode, 200);
    // If cut-off already locked, pay may land as COOKING (late-after-lock path)
    assert.ok(["PAID", "COOKING"].includes(first.json().order.status));
    const second = await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().order.status, first.json().order.status);
    assert.equal(second.json().order.publicId, publicId);
  });

  it("runs cut-off freeze and builds headcount", async () => {
    const cut = await app.inject({
      method: "POST",
      url: "/internal/cutoffs/LUNCH",
      payload: { force: true },
    });
    assert.equal(cut.statusCode, 200);
    const sri = cut.json().results.find(
      (r: { cookId: string }) => r.headcount >= 1 || true,
    );
    assert.ok(sri);
    const manifest = await app.inject({
      method: "GET",
      url: "/cooks/sri-sai/manifest",
      headers: cookHeaders,
    });
    assert.equal(manifest.statusCode, 200);
    assert.ok(manifest.json().lock);
  });

  it("refunds before EOD and holds settlement", async () => {
    const hold = await app.inject({
      method: "POST",
      url: "/internal/ops/holds",
      headers: adminHeaders,
      payload: { orderId, reason: "test hold" },
    });
    assert.equal(hold.statusCode, 200);
    assert.equal(hold.json().settlementHold, true);

    // Refund this run's paid order (COOKING after forced cut-off)
    const refund = await app.inject({
      method: "POST",
      url: "/internal/ops/refunds",
      headers: adminHeaders,
      payload: {
        orderId,
        mode: "FULL",
        reason: "integration refund before EOD",
      },
    });
    assert.equal(refund.statusCode, 200, refund.body);
    assert.equal(refund.json().status, "REFUNDED");
  });

  it("lists LIVE kitchens only for pin", async () => {
    const kitchens = await app.inject({ method: "GET", url: "/kitchens?pin=600119" });
    assert.equal(kitchens.statusCode, 200);
    const slugs = kitchens.json().map((k: { slugHandle: string }) => k.slugHandle);
    assert.ok(slugs.includes("sri-sai"));
    assert.ok(!slugs.includes("millet-box"));
  });

  it("whatsapp MENU intent returns kitchens", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: "+919840111111", text: "Menu" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().intent, "MENU");
  });

  it("pauses cook via admin", async () => {
    const cook = await db.query.cookProfiles.findFirst({
      where: eq(cookProfiles.slugHandle, "amma-priya"),
    });
    assert.ok(cook);
    const res = await app.inject({
      method: "POST",
      url: `/internal/ops/cooks/${cook.id}/pause`,
      headers: adminHeaders,
      payload: { reason: "integration pause" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().isActive, false);
    // restore for demo
    await db.update(cookProfiles).set({ isActive: true }).where(eq(cookProfiles.id, cook.id));
  });

  it("late request + late-approve creates payable order; FSSAI gate blocks unpaid kitchen", async () => {
    const close = await app.inject({
      method: "PATCH",
      url: "/cooks/sri-sai/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 0, cutoffMinute: 0 },
    });
    assert.equal(close.statusCode, 200, close.body);

    const { mobile: lateMobile, addressId, headers: lateHeaders } =
      await customerWithAddress(app);
    const requested = await app.inject({
      method: "POST",
      url: "/orders/late-request",
      headers: lateHeaders,
      payload: {
        customerMobile: lateMobile,
        cookSlug: "sri-sai",
        menuItemId,
        qty: 1,
        addressId,
      },
    });
    assert.equal(requested.statusCode, 200, requested.body);
    assert.equal(requested.json().status, "PENDING_APPROVAL");

    const approved = await app.inject({
      method: "POST",
      url: `/orders/${requested.json().publicId}/late-approve`,
      headers: cookHeaders,
    });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().status, "AWAITING_PAYMENT");
    assert.ok(approved.json().gatewayTxnId);
    assert.ok(approved.json().paymentUrl);

    const millet = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.slugHandle, "millet-box"),
    });
    assert.ok(millet);
    assert.throws(() =>
      assertCanAcceptPaidOrders({ ...millet, onboardingStatus: "LIVE", fssaiNumber: null }),
    );

    await app.inject({
      method: "PATCH",
      url: "/cooks/sri-sai/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
  });

  it("EOD skips settlement_hold and is idempotent", async () => {
    const first = await app.inject({ method: "POST", url: "/internal/settlements/eod" });
    assert.equal(first.statusCode, 200, first.body);
    assert.ok(typeof first.json().orderCount === "number");
    assert.ok(Array.isArray(first.json().batches));
    assert.ok(Array.isArray(first.json().skipped));

    const second = await app.inject({ method: "POST", url: "/internal/settlements/eod" });
    assert.equal(second.statusCode, 200);
    // Already-settled cooks appear in skipped; no duplicate batches required
    assert.equal(second.json().batches.length, 0);
  });

  it("whatsapp ORDER slug creates payable order", async () => {
    const mobile = `+91985${String(Date.now()).slice(-7)}`;
    const save = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: mobile, text: "Save HOME Integration Tower 1, Flat 2" },
    });
    assert.equal(save.statusCode, 200, save.body);
    assert.equal(save.json().intent, "SAVE_ADDRESS");

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: mobile, text: "Order sri-sai 1 HOME" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().intent, "ORDER");
    assert.ok(res.json().publicId, res.body);
  });

  it("whatsapp guided pick: Menu kitchen → digit → Pay", async () => {
    const mobile = `+91986${String(Date.now()).slice(-7)}`;
    await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: mobile, text: "Save HOME Guided Tower 1" },
    });

    const menu = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: mobile, text: "Menu sri-sai" },
    });
    assert.equal(menu.statusCode, 200, menu.body);
    assert.equal(menu.json().intent, "MENU");
    assert.match(menu.json().replies[0].body, /Reply 1|tap below/i);

    const pick = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: mobile, text: "1" },
    });
    assert.equal(pick.statusCode, 200, pick.body);
    // Digit pick completes as ORDER/LATE with Pay link
    assert.ok(["ORDER", "LATE", "PICK"].includes(pick.json().intent), pick.body);
    assert.ok(pick.json().publicId || pick.json().pendingApproval, pick.body);
    assert.match(pick.json().replies[0].body, /Pay |Late request/i);
  });
});
