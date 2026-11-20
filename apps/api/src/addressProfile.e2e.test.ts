/**
 * API e2e: profile + addresses + checkout address requirement + WA address pick.
 * Runs against real DB (seed required) via Fastify inject.
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { closeDb, createDb } from "@localmeals/db";
import {
  customerWithAddress,
  ensureHomeAddress,
  loginCook,
  loginCustomer,
  testMobile,
} from "./testHelpers.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";
process.env.WHATSAPP_VERIFY_TOKEN = "localmeals-dev";

describe("address + profile e2e", () => {
  const db = createDb();
  const app = buildApp(db);
  let cookHeaders: { authorization: string };
  let menuItemId = 1;

  before(async () => {
    await app.ready();
    const cookAuth = await loginCook(app, "csk-homemade-delights");
    cookHeaders = cookAuth.headers;
    await app.inject({
      method: "PATCH",
      url: "/cooks/csk-homemade-delights/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    assert.ok(menu.json().menus?.[0], "No menu for csk-homemade-delights today — run npm run db:seed");
    menuItemId = menu.json().menus[0].id;
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("PATCH /me/profile updates name and pin", async () => {
    const { headers, mobile } = await loginCustomer(app);
    const res = await app.inject({
      method: "PATCH",
      url: "/me/profile",
      headers,
      payload: { fullName: "E2E Customer", pinCode: "600119" },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().fullName, "E2E Customer");
    assert.equal(res.json().pinCode, "600119");
    assert.equal(res.json().needsName, false);

    const got = await app.inject({ method: "GET", url: "/me/profile", headers });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().mobile, mobile);
    assert.equal(got.json().fullName, "E2E Customer");
  });

  it("POST /me/addresses creates HOME and OFFICE", async () => {
    const { headers } = await loginCustomer(app);
    const home = await app.inject({
      method: "POST",
      url: "/me/addresses",
      headers,
      payload: {
        label: "HOME",
        line1: "E2E Home Tower 1",
        pinCode: "600119",
        isDefault: true,
      },
    });
    assert.equal(home.statusCode, 200, home.body);
    assert.equal(home.json().label, "HOME");

    const office = await app.inject({
      method: "POST",
      url: "/me/addresses",
      headers,
      payload: {
        label: "OFFICE",
        line1: "E2E Office Park",
        pinCode: "600113",
      },
    });
    assert.equal(office.statusCode, 200, office.body);

    const list = await app.inject({ method: "GET", url: "/me/addresses", headers });
    assert.equal(list.statusCode, 200);
    const labels = (list.json().addresses as Array<{ label: string }>).map((a) => a.label);
    assert.ok(labels.includes("HOME"));
    assert.ok(labels.includes("OFFICE"));
  });

  it("web checkout rejects order without addressId", async () => {
    const { mobile, headers } = await loginCustomer(app);
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload: {
        customerMobile: mobile,
        cookSlug: "csk-homemade-delights",
        menuItemId,
        qty: 1,
        spice: "NORMAL",
      },
    });
    assert.equal(res.statusCode, 400, res.body);
    assert.match(res.json().error, /address/i);
  });

  it("web checkout accepts order with addressId and snapshots line", async () => {
    const { mobile, addressId, headers } = await customerWithAddress(app);
    const res = await app.inject({
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
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, "AWAITING_PAYMENT");
    assert.equal(res.json().addressId, addressId);
    assert.match(res.json().deliveryTargetAddress, /Test Tower|E2E|Tower|Flat/i);
  });

  it("batch checkout requires addressId for delivery", async () => {
    const { mobile, addressId, headers } = await customerWithAddress(app);
    const week = await app.inject({
      method: "GET",
      url: "/kitchens/csk-homemade-delights/week?days=7&meal=LUNCH",
    });
    assert.equal(week.statusCode, 200);
    const day = (week.json().plan as Array<{ serviceDate: string; menus: Array<{ id: number }>; orderingOpen: boolean }>).find(
      (d) => d.orderingOpen && d.menus.length > 0,
    );
    assert.ok(day, "need an open lunch day with plates");

    const missing = await app.inject({
      method: "POST",
      url: "/orders/batch",
      headers,
      payload: {
        customerMobile: mobile,
        cookSlug: "csk-homemade-delights",
        lines: [{ menuItemId: day.menus[0].id, serviceDate: day.serviceDate, qty: 1, spice: "NORMAL" }],
      },
    });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().error, /address/i);

    const ok = await app.inject({
      method: "POST",
      url: "/orders/batch",
      headers,
      payload: {
        customerMobile: mobile,
        cookSlug: "csk-homemade-delights",
        addressId,
        lines: [{ menuItemId: day.menus[0].id, serviceDate: day.serviceDate, qty: 1, spice: "NORMAL" }],
      },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(ok.json().checkoutId?.startsWith("CHK-"));
    assert.equal(ok.json().orders[0].addressId, addressId);
  });

  it("WhatsApp: Save HOME → Order with HOME label", async () => {
    const m = testMobile("77");
    // Ensure user row exists + session for owner-scoped order GET
    const { headers } = await loginCustomer(app, m);

    const save = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: {
        from: m,
        text: "Save HOME E2E WA Tower 9, Flat 202",
      },
    });
    assert.equal(save.statusCode, 200, save.body);
    assert.equal(save.json().intent, "SAVE_ADDRESS");
    assert.ok(save.json().addressId);

    // No address label → auto-use the HOME just saved, straight to Pay
    const pick = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: m, text: "Order csk-homemade-delights 1" },
    });
    assert.equal(pick.statusCode, 200, pick.body);
    assert.equal(pick.json().intent, "ORDER");
    assert.ok(pick.json().publicId, pick.body);
    assert.match(pick.json().replies[0].body, /Deliver to HOME/i);
    assert.match(pick.json().replies[0].body, /Pay /i);

    const order = await app.inject({
      method: "GET",
      url: `/orders/${pick.json().publicId}`,
      headers,
    });
    assert.equal(order.statusCode, 200);
    assert.match(order.json().deliveryTargetAddress, /E2E WA Tower 9/);
  });

  it("PATCH /me/addresses/:id updates line1", async () => {
    const { headers } = await loginCustomer(app);
    const id = await ensureHomeAddress(app, headers, "Before edit address line");
    const patched = await app.inject({
      method: "PATCH",
      url: `/me/addresses/${id}`,
      headers,
      payload: { line1: "After edit address line XYZ" },
    });
    assert.equal(patched.statusCode, 200, patched.body);
    assert.equal(patched.json().line1, "After edit address line XYZ");
  });
});
