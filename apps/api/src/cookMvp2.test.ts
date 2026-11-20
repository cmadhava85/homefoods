import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { closeDb, createDb } from "@localmeals/db";
import { loginAdmin, loginCook } from "./testHelpers.js";

process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

describe("cook MVP-2 settings", () => {
  const db = createDb();
  const app = buildApp(db);
  let headers: { authorization: string };
  const slug = "csk-homemade-delights";

  before(async () => {
    await app.ready();
    headers = (await loginCook(app, slug)).headers;
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("meal-settings includes week discount + pickup", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/cooks/${slug}/meal-settings`,
      headers,
    });
    assert.equal(res.statusCode, 200, res.body);
    const json = res.json();
    assert.ok(json.weekDiscount);
    assert.equal(typeof json.weekDiscount.percent, "number");
    assert.equal(typeof json.weekDiscount.minDays, "number");
    assert.equal(typeof json.weekDiscount.platformEnabled, "boolean");
    assert.ok(json.pickup);
    assert.equal(typeof json.pickup.enabled, "boolean");
    assert.equal(typeof json.pickup.platformEnabled, "boolean");
  });

  it("saves week discount (cap 15%)", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/cooks/${slug}/week-discount`,
      headers,
      payload: { percent: 10, minDays: 3 },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().weekDiscountPercent, 10);
    assert.equal(res.json().weekDiscountMinDays, 3);

    const over = await app.inject({
      method: "PATCH",
      url: `/cooks/${slug}/week-discount`,
      headers,
      payload: { percent: 40, minDays: 3 },
    });
    assert.ok(over.statusCode >= 400);
  });

  it("rejects pickup enable without landmark", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/cooks/${slug}/pickup`,
      headers,
      payload: { pickupEnabled: true, pickupLandmark: "" },
    });
    assert.ok(res.statusCode >= 400, res.body);
  });

  it("saves pickup landmark + enable", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/cooks/${slug}/pickup`,
      headers,
      payload: {
        pickupEnabled: true,
        pickupLandmark: "Blue gate near temple",
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().pickupEnabled, true);
    assert.equal(res.json().pickupLandmark, "Blue gate near temple");

    const off = await app.inject({
      method: "PATCH",
      url: `/cooks/${slug}/pickup`,
      headers,
      payload: { pickupEnabled: false },
    });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().pickupEnabled, false);
  });

  it("toggles intake pause for today", async () => {
    const on = await app.inject({
      method: "PATCH",
      url: `/cooks/${slug}/intake-pause`,
      headers,
      payload: { paused: true },
    });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(on.json().paused, true);
    assert.ok(on.json().pausedDate);

    const settings = await app.inject({
      method: "GET",
      url: `/cooks/${slug}/meal-settings`,
      headers,
    });
    assert.equal(settings.json().intake?.paused, true);

    const off = await app.inject({
      method: "PATCH",
      url: `/cooks/${slug}/intake-pause`,
      headers,
      payload: { paused: false },
    });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(off.json().paused, false);
  });

  it("saves fulfillment offers and named template", async () => {
    const fulfill = await app.inject({
      method: "PATCH",
      url: `/cooks/${slug}/fulfillment`,
      headers,
      payload: {
        cookDelivery: true,
        customerArrange: true,
        pickupEnabled: false,
        pickupLandmark: "Blue gate",
      },
    });
    assert.equal(fulfill.statusCode, 200, fulfill.body);
    assert.equal(fulfill.json().fulfillmentOffers.customerArrange, true);

    const none = await app.inject({
      method: "PATCH",
      url: `/cooks/${slug}/fulfillment`,
      headers,
      payload: {
        cookDelivery: false,
        customerArrange: false,
        pickupEnabled: false,
      },
    });
    assert.ok(none.statusCode >= 400, none.body);

    const tpl = await app.inject({
      method: "POST",
      url: `/cooks/${slug}/menu-templates`,
      headers,
      payload: {
        name: "Weekday lunch",
        mealType: "LUNCH",
        items: [{ itemName: "Sambar rice", pricePaise: 8000, isVeg: true }],
      },
    });
    assert.equal(tpl.statusCode, 201, tpl.body);
    const list = await app.inject({
      method: "GET",
      url: `/cooks/${slug}/menu-templates?meal=LUNCH`,
      headers,
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.ok((list.json().templates as unknown[]).some((x: { name: string }) => x.name === "Weekday lunch"));
  });

  it("desk reviews include soft-launch min", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/cooks/${slug}/reviews`,
      headers,
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().softLaunchMin, 3);
    assert.ok(res.json().summary);
    assert.ok(Array.isArray(res.json().reviews));
  });
});

describe("admin turnover analytics", () => {
  const db = createDb();
  const app = buildApp(db);
  let adminHeaders: { authorization: string };

  before(async () => {
    await app.ready();
    adminHeaders = (await loginAdmin(app)).headers;
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("rejects anonymous", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/analytics/turnover?period=week",
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403);
  });

  it("returns week/month/year platform + cooks shape", async () => {
    for (const period of ["week", "month", "year"] as const) {
      const res = await app.inject({
        method: "GET",
        url: `/admin/analytics/turnover?period=${period}`,
        headers: adminHeaders,
      });
      assert.equal(res.statusCode, 200, res.body);
      const json = res.json();
      assert.equal(json.range.period, period);
      assert.ok(json.range.from <= json.range.to);
      assert.ok(json.platform);
      assert.equal(typeof json.platform.foodGmvPaise, "number");
      assert.equal(typeof json.platform.platformFeePaise, "number");
      assert.ok(Array.isArray(json.cooks));
      assert.equal(typeof json.liveCookCount, "number");
    }
  });
});
