/**
 * DPDP erasure: POST /me/account/delete anonymises retained orders and removes personal data.
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { buildApp } from "./app.js";
import { addresses, closeDb, cookProfiles, createDb, orders, users } from "@localmeals/db";
import { customerWithAddress, loginCook, loginCustomer } from "./testHelpers.js";
import { REDACTED_ADDRESS } from "./services/accountDeletion.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

describe("account deletion (DPDP erasure)", () => {
  const db = createDb();
  const app = buildApp(db);
  let menuItemId = 0;

  before(async () => {
    await app.ready();
    await app.inject({
      method: "PATCH",
      url: "/cooks/csk-homemade-delights/meal-settings/LUNCH",
      headers: (await loginCook(app, "csk-homemade-delights")).headers,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    assert.ok(menu.json().menus?.[0], "seed menu missing — run npm run db:seed");
    menuItemId = menu.json().menus[0].id;
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("requires a signed-in customer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/me/account/delete",
      payload: { confirm: "DELETE" },
    });
    assert.equal(res.statusCode, 401, res.body);
  });

  it("blocks while an order is in progress, then anonymises after it is cancelled", async () => {
    const { headers, mobile, addressId } = await customerWithAddress(app);
    const created = await app.inject({
      method: "POST",
      url: "/orders",
      headers,
      payload: { customerMobile: mobile, cookSlug: "csk-homemade-delights", menuItemId, qty: 1, spice: "NORMAL", addressId },
    });
    assert.equal(created.statusCode, 200, created.body);
    const publicId = created.json().publicId as string;

    const blocked = await app.inject({
      method: "POST",
      url: "/me/account/delete",
      headers,
      payload: { confirm: "DELETE" },
    });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.match(blocked.json().error, new RegExp(publicId));

    const cancelled = await app.inject({ method: "POST", url: `/orders/${publicId}/cancel`, headers });
    assert.equal(cancelled.statusCode, 200, cancelled.body);

    const unconfirmed = await app.inject({
      method: "POST",
      url: "/me/account/delete",
      headers,
      payload: { confirm: "yes" },
    });
    assert.equal(unconfirmed.statusCode, 400, unconfirmed.body);

    const res = await app.inject({
      method: "POST",
      url: "/me/account/delete",
      headers,
      payload: { confirm: "DELETE" },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().anonymisedOrders, 1);
    assert.match(String(res.headers["set-cookie"]), /Max-Age=0|Expires=Thu, 01 Jan 1970/i);

    assert.equal(await db.query.users.findFirst({ where: eq(users.mobileNumber, mobile) }), undefined);
    const left = await db.select().from(addresses).where(eq(addresses.userMobile, mobile));
    assert.equal(left.length, 0);

    const order = await db.query.orders.findFirst({ where: eq(orders.publicId, publicId) });
    assert.ok(order);
    assert.notEqual(order.customerMobile, mobile);
    assert.match(order.customerMobile, /^x[0-9a-f]{14}$/);
    assert.equal(order.deliveryTargetAddress, REDACTED_ADDRESS);
    assert.equal(order.addressId, null);
    // Financial snapshot is retained for tax records.
    assert.ok(order.foodPaise > 0);

    // The old session is revoked.
    const me = await app.inject({ method: "GET", url: "/me/profile", headers });
    assert.equal(me.statusCode, 401, me.body);

    // The number can sign up again as a fresh customer with no history.
    const again = await loginCustomer(app, mobile);
    const history = await app.inject({ method: "GET", url: "/me/orders", headers: again.headers });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.body.includes(publicId), false);
  });

  it("refuses for a number that owns a kitchen", async () => {
    const cook = await db.query.cookProfiles.findFirst({
      where: eq(cookProfiles.slugHandle, "csk-homemade-delights"),
    });
    assert.ok(cook);
    const { headers } = await loginCustomer(app, cook.mobileNumber);
    const res = await app.inject({
      method: "POST",
      url: "/me/account/delete",
      headers,
      payload: { confirm: "DELETE" },
    });
    assert.equal(res.statusCode, 409, res.body);
    assert.match(res.json().error, /kitchen/i);
  });
});
