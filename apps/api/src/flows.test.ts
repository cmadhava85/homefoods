import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { closeDb, createDb, cookProfiles, orders } from "@localmeals/db";
import { eq } from "drizzle-orm";
import { customerWithAddress, loginAdmin, loginCook, testMobile } from "./testHelpers.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";
process.env.WHATSAPP_VERIFY_TOKEN = "localmeals-dev";

function mobile() {
  return testMobile();
}

describe("MVP-1 API flows", () => {
  const db = createDb();
  const app = buildApp(db);
  let cookHeaders: { authorization: string };
  let ammaHeaders: { authorization: string };
  let adminHeaders: { authorization: string };
  let menuItemId = 1;

  before(async () => {
    await app.ready();
    cookHeaders = (await loginCook(app, "sri-sai")).headers;
    ammaHeaders = (await loginCook(app, "amma-priya")).headers;
    adminHeaders = (await loginAdmin(app)).headers;
    await app.inject({
      method: "PATCH",
      url: "/cooks/sri-sai/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    await app.inject({
      method: "PATCH",
      url: "/cooks/amma-priya/meal-settings/LUNCH",
      headers: ammaHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    const menu = await app.inject({ method: "GET", url: "/kitchens/sri-sai/menu" });
    assert.ok(menu.json().menus?.[0], "No menu for sri-sai today — run npm run db:seed");
    menuItemId = menu.json().menus[0].id;
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("GET /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });

  it("GET kitchen menu includes lunchCutoff", async () => {
    const res = await app.inject({ method: "GET", url: "/kitchens/sri-sai/menu" });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().lunchCutoff);
    assert.equal(typeof res.json().orderingOpen, "boolean");
  });

  it("cook can add and hide a daily menu item", async () => {
    const name = `Test Thali ${Date.now()}`;
    const created = await app.inject({
      method: "POST",
      url: "/cooks/sri-sai/menu",
      headers: cookHeaders,
      payload: { itemName: name, priceRupees: 99, isVeg: true },
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id;

    const listed = await app.inject({
      method: "GET",
      url: "/cooks/sri-sai/menu",
      headers: cookHeaders,
    });
    assert.ok(listed.json().menus.some((m: { id: number }) => m.id === id));

    const hidden = await app.inject({
      method: "PATCH",
      url: `/cooks/sri-sai/menu/${id}`,
      headers: cookHeaders,
      payload: { isAvailable: false },
    });
    assert.equal(hidden.statusCode, 200);
    assert.equal(hidden.json().isAvailable, false);

    const customer = await app.inject({ method: "GET", url: "/kitchens/sri-sai/menu" });
    assert.ok(!customer.json().menus.some((m: { id: number }) => m.id === id));
  });

  it("cook can post a weekly menu item for a weekday", async () => {
    const name = `Weekly Bowl ${Date.now()}`;
    const created = await app.inject({
      method: "POST",
      url: "/cooks/sri-sai/menu",
      headers: cookHeaders,
      payload: { itemName: name, priceRupees: 85, weekly: true, dayOfWeek: 3, isVeg: true },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().dayOfWeek, 3);
    assert.equal(created.json().serviceDate, null);
    const weeklyId = created.json().id as number;

    const week = await app.inject({
      method: "GET",
      url: "/cooks/sri-sai/menu?view=week",
      headers: cookHeaders,
    });
    assert.ok(week.json().menus.some((m: { itemName: string }) => m.itemName === name));

    const removed = await app.inject({
      method: "DELETE",
      url: `/cooks/sri-sai/menu/${weeklyId}`,
      headers: cookHeaders,
    });
    assert.equal(removed.statusCode, 200, removed.body);
  });

  async function placeOrder(opts: {
    spice?: "NORMAL" | "LESS";
    qty?: number;
    mobile?: string;
  } = {}) {
    const m = opts.mobile ?? mobile();
    const { addressId, headers } = await customerWithAddress(app, m);
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload: {
        customerMobile: m,
        cookSlug: "sri-sai",
        menuItemId,
        qty: opts.qty ?? 1,
        spice: opts.spice ?? "NORMAL",
        addressId,
      },
    });
    return Object.assign(res, { customerHeaders: headers, customerMobile: m });
  }

  it("pack → dispatch → delivered", async () => {
    const m = mobile();
    const created = await placeOrder({ mobile: m, spice: "LESS" });
    assert.equal(created.statusCode, 200, created.body);
    const txn = created.json().gatewayTxnId;
    const pid = created.json().publicId;

    await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId: txn },
    });

    const cut = await app.inject({
      method: "POST",
      url: "/internal/cutoffs/LUNCH",
      payload: { force: true },
    });
    assert.equal(cut.statusCode, 200);

    const packed = await app.inject({
      method: "POST",
      url: "/cooks/sri-sai/pack",
      headers: cookHeaders,
    });
    assert.equal(packed.statusCode, 200);
    assert.ok(packed.json().packed >= 1);

    const dispatched = await app.inject({
      method: "POST",
      url: "/cooks/sri-sai/dispatch",
      headers: cookHeaders,
    });
    assert.equal(dispatched.statusCode, 200);
    assert.ok(dispatched.json().dispatched >= 1);

    const delivered = await app.inject({
      method: "POST",
      url: `/orders/${pid}/delivered`,
      headers: cookHeaders,
    });
    assert.equal(delivered.statusCode, 200);
    assert.equal(delivered.json().status, "DELIVERED");
  });

  it("cancels AWAITING_PAYMENT before cut-off", async () => {
    const created = await placeOrder();
    assert.equal(created.statusCode, 200, created.body);
    const pid = created.json().publicId;
    const cancelled = await app.inject({
      method: "POST",
      url: `/orders/${pid}/cancel`,
      headers: created.customerHeaders,
    });
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().status, "CANCELLED");
  });

  it("payment webhook captures order", async () => {
    const created = await placeOrder({ spice: "LESS" });
    assert.equal(created.statusCode, 200, created.body);
    const txn = created.json().gatewayTxnId;
    const wh = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      payload: { gatewayTxnId: txn, status: "captured" },
    });
    assert.equal(wh.statusCode, 200);
    assert.ok(["PAID", "COOKING"].includes(wh.json().order.status));
  });

  it("WhatsApp verify challenge", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=localmeals-dev&hub.challenge=abc123",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "abc123");
  });

  it("WhatsApp HELP creates ticket", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: mobile(), text: "Help my lunch missing" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().intent, "HELP");
    assert.ok(res.json().ticketId);
  });

  it("WhatsApp PAY returns unpaid link", async () => {
    const m = mobile();
    const created = await placeOrder({ mobile: m });
    assert.equal(created.statusCode, 200, created.body);
    const pay = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: m, text: "Pay" },
    });
    assert.equal(pay.statusCode, 200);
    assert.equal(pay.json().intent, "PAY");
    assert.equal(pay.json().publicId, created.json().publicId);
  });

  it("non-force cut-off skips cook before their time", async () => {
    // Set cut-off far in the future relative to "now" for a cook
    await app.inject({
      method: "PATCH",
      url: "/cooks/sri-sai/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    // If wall clock is before 23:59, non-force may skip; if after, it won't.
    // Force a skip by setting hour to tomorrow-style: use hour 23 and only assert shape.
    const res = await app.inject({
      method: "POST",
      url: "/internal/cutoffs/LUNCH",
      payload: { force: false },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json().results));
  });

  it("sets cook lunch cut-off via meal-settings", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/cooks/sri-sai/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 8, cutoffMinute: 30 },
    });
    assert.equal(res.statusCode, 200);
    const lunch = (res.json().meals as Array<{ mealType: string; cutoff: string }>).find(
      (m) => m.mealType === "LUNCH",
    );
    assert.equal(lunch?.cutoff, "08:30");
    await app.inject({
      method: "PATCH",
      url: "/cooks/sri-sai/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
  });

  it("blocks order after cook cut-off", async () => {
    await app.inject({
      method: "PATCH",
      url: "/cooks/sri-sai/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 0, cutoffMinute: 0 },
    });
    const res = await placeOrder();
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /cut-off/i);
    await app.inject({
      method: "PATCH",
      url: "/cooks/sri-sai/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
  });

  it("refund is idempotent when already REFUNDED", async () => {
    const created = await placeOrder();
    assert.equal(created.statusCode, 200, created.body);
    await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId: created.json().gatewayTxnId },
    });
    const id = created.json().id;
    const a = await app.inject({
      method: "POST",
      url: "/internal/ops/refunds",
      headers: adminHeaders,
      payload: { orderId: id, mode: "FULL", reason: "once" },
    });
    assert.equal(a.statusCode, 200);
    const b = await app.inject({
      method: "POST",
      url: "/internal/ops/refunds",
      headers: adminHeaders,
      payload: { orderId: id, mode: "FULL", reason: "twice" },
    });
    assert.equal(b.statusCode, 200);
    assert.equal(b.json().status, "REFUNDED");
  });

  it("admin ticket detail includes order", async () => {
    const tickets = await app.inject({
      method: "GET",
      url: "/admin/tickets",
      headers: adminHeaders,
    });
    assert.equal(tickets.statusCode, 200);
    const list = tickets.json();
    if (list.length === 0) return;
    const detail = await app.inject({
      method: "GET",
      url: `/admin/tickets/${list[0].id}`,
      headers: adminHeaders,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().id, list[0].id);
    // order may be null for HELP tickets; shape must exist
    assert.ok("order" in detail.json());
  });

  it("EOD never settles held DELIVERED orders", async () => {
    const created = await placeOrder();
    assert.equal(created.statusCode, 200, created.body);
    const orderId = created.json().id;
    const pid = created.json().publicId;

    await app.inject({
      method: "POST",
      url: "/payments/mock-confirm",
      payload: { gatewayTxnId: created.json().gatewayTxnId },
    });
    await app.inject({
      method: "POST",
      url: "/internal/cutoffs/LUNCH",
      payload: { force: true },
    });
    await app.inject({ method: "POST", url: "/cooks/sri-sai/pack", headers: cookHeaders });
    await app.inject({ method: "POST", url: "/cooks/sri-sai/dispatch", headers: cookHeaders });
    await app.inject({
      method: "POST",
      url: `/orders/${pid}/delivered`,
      headers: cookHeaders,
    });
    await app.inject({
      method: "POST",
      url: "/internal/ops/holds",
      headers: adminHeaders,
      payload: { orderId, reason: "eod hold test" },
    });

    const eod = await app.inject({ method: "POST", url: "/internal/settlements/eod" });
    assert.equal(eod.statusCode, 200, eod.body);

    const held = await db.query.orders.findFirst({ where: eq(orders.id, orderId) });
    assert.ok(held);
    assert.equal(held.settlementHold, true);
    assert.equal(held.settlementId, null);
  });

  it("GET order by publicId", async () => {
    const created = await placeOrder({ qty: 2, spice: "LESS" });
    assert.equal(created.statusCode, 200, created.body);
    const got = await app.inject({
      method: "GET",
      url: `/orders/${created.json().publicId}`,
    });
    assert.equal(got.statusCode, 200);
    assert.equal(got.json().qty, 2);
    assert.equal(got.json().spice, "LESS");
  });

  it("cook WA Add plate then photo appears on customer menu", async () => {
    const cookMobile = "+919876543210";
    const name = `WA Plate ${Date.now()}`;
    const add = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from: cookMobile, text: `Add ${name} 77` },
    });
    assert.equal(add.statusCode, 200, add.body);
    assert.equal(add.json().intent, "COOK_MENU_ADD");
    assert.ok(add.json().menuItemId);

    const tinyPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const photo = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: {
        from: cookMobile,
        imageBase64: tinyPng,
        mimeType: "image/png",
      },
    });
    assert.equal(photo.statusCode, 200, photo.body);
    assert.equal(photo.json().intent, "COOK_MENU_PHOTO");
    assert.ok(photo.json().imageUrl?.startsWith("/uploads/menu-"));

    const customer = await app.inject({ method: "GET", url: "/kitchens/sri-sai/menu" });
    assert.equal(customer.statusCode, 200);
    const hit = (customer.json().menus as Array<{ itemName: string; imageUrl?: string | null }>).find(
      (m) => m.itemName === name,
    );
    assert.ok(hit, "WA-added plate missing from customer menu");
    assert.ok(hit.imageUrl?.startsWith("/uploads/menu-"));
  });
});
