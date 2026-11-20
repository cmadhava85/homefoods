import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatOrderPaidCookWa,
  formatOrderPaidCustomerWa,
  formatOrderPaidFeedPreview,
} from "./orderPaidNotify.js";

const single = {
  publicId: "ord_a",
  serviceDate: "2026-11-18",
  mealType: "LUNCH",
  itemName: "Sambar rice",
  qty: 1,
  spice: "NORMAL",
  deliveryWindow: "12:30–1:30",
  deliveryTargetAddress: "12 MG Road",
  customerMobile: "+919999000001",
  cookSlug: "csk-homemade-delights",
  checkoutDayCount: 1,
  checkoutDayOrdinal: 1,
};

const weekDay2 = {
  ...single,
  publicId: "ord_b",
  serviceDate: "2026-11-19",
  checkoutId: "chk_week1",
  checkoutDayCount: 3,
  checkoutDayOrdinal: 2,
};

describe("orderPaidNotify", () => {
  it("cook WA includes service date for single-day", () => {
    const body = formatOrderPaidCookWa(single);
    assert.equal(
      body,
      [
        "🆕 New PAID Lunch order",
        "For 2026-11-18",
        "ord_a · 1× Sambar rice",
        "Spice: NORMAL",
        "ETA window: 12:30–1:30",
        "📍 12 MG Road",
        "Customer: +919999000001",
        "Reply Status · Cooking · Packed on WhatsApp.",
      ].join("\n"),
    );
  });

  it("cook WA marks week-cart day ordinal and checkout id", () => {
    const body = formatOrderPaidCookWa(weekDay2);
    assert.equal(
      body,
      [
        "🆕 New PAID Lunch · day 2 of 3",
        "For 2026-11-19",
        "Week cart chk_week1",
        "ord_b · 1× Sambar rice",
        "Spice: NORMAL",
        "ETA window: 12:30–1:30",
        "📍 12 MG Road",
        "Customer: +919999000001",
        "This plate is for that day only — Status shows today’s queue. Reply Status · Cooking · Packed.",
      ].join("\n"),
    );
  });

  it("cook WA defaults meal, qty, plate, and address; omits optional spice/window", () => {
    const body = formatOrderPaidCookWa({
      publicId: "ord_x",
      mealType: "brunch",
      itemName: "",
      qty: undefined,
      customerMobile: 42,
      deliveryTargetAddress: null,
      checkoutDayCount: 0,
      checkoutDayOrdinal: -1,
    });
    assert.match(body, /^🆕 New PAID Lunch order$/m);
    assert.match(body, /ord_x · 1× plate/);
    assert.match(body, /📍 address TBD/);
    assert.match(body, /Customer: 42/);
    assert.doesNotMatch(body, /Spice:/);
    assert.doesNotMatch(body, /ETA window:/);
    assert.doesNotMatch(body, /For /);
    assert.doesNotMatch(body, /Week cart/);
  });

  it("cook WA accepts BREAKFAST and DINNER meal labels", () => {
    assert.match(formatOrderPaidCookWa({ ...single, mealType: "breakfast" }), /New PAID Breakfast order/);
    assert.match(formatOrderPaidCookWa({ ...single, mealType: "DINNER" }), /New PAID Dinner order/);
  });

  it("cook WA week without checkoutId skips Week cart line", () => {
    const body = formatOrderPaidCookWa({
      ...weekDay2,
      checkoutId: "",
    });
    assert.match(body, /day 2 of 3/);
    assert.doesNotMatch(body, /Week cart/);
  });

  it("customer WA explains per-day cooking on week cart", () => {
    const body = formatOrderPaidCustomerWa(weekDay2);
    assert.equal(
      body,
      [
        "✅ Payment received · ord_b",
        "For 2026-11-19",
        "Week cart chk_week1 · day 2 of 3",
        "1× Sambar rice",
        "ETA 12:30–1:30",
        "Kitchen: csk-homemade-delights",
        "Each day cooks separately — we’ll ping when that day’s plate is on the way. Reply Orders anytime.",
      ].join("\n"),
    );
  });

  it("customer WA single-day omits week lines", () => {
    const body = formatOrderPaidCustomerWa(single);
    assert.equal(
      body,
      [
        "✅ Payment received · ord_a",
        "For 2026-11-18",
        "1× Sambar rice",
        "ETA 12:30–1:30",
        "Kitchen: csk-homemade-delights",
        "We’ll ping you when it’s on the way / delivered. Reply Orders anytime.",
      ].join("\n"),
    );
  });

  it("customer WA week without checkoutId and without kitchen/window", () => {
    const body = formatOrderPaidCustomerWa({
      publicId: "ord_c",
      checkoutDayCount: 2,
      checkoutDayOrdinal: 1,
      itemName: null,
      qty: 3,
      cookSlug: "",
      deliveryWindow: "",
    });
    assert.match(body, /Week cart · day 1 of 2/);
    assert.match(body, /3× plate/);
    assert.doesNotMatch(body, /Kitchen:/);
    assert.doesNotMatch(body, /ETA /);
    assert.match(body, /Each day cooks separately/);
  });

  it("desk feed preview shows date and week day index", () => {
    assert.equal(
      formatOrderPaidFeedPreview(weekDay2),
      "New PAID 2026-11-19 · ord_b · 1× Sambar rice · week day 2/3",
    );
    assert.equal(
      formatOrderPaidFeedPreview(single),
      "New PAID 2026-11-18 · ord_a · 1× Sambar rice",
    );
  });

  it("desk feed preview handles missing date, qty, and item", () => {
    assert.equal(
      formatOrderPaidFeedPreview({
        publicId: "ord_z",
        serviceDate: "",
        itemName: "",
        checkoutDayCount: "2",
        checkoutDayOrdinal: "1",
      }),
      "New PAID ord_z · 1× plate · week day 1/2",
    );
  });

  it("coerces non-string publicId and floors day counts", () => {
    const body = formatOrderPaidCookWa({
      publicId: 99,
      checkoutDayCount: 2.9,
      checkoutDayOrdinal: 1.2,
      checkoutId: "chk",
      itemName: "Dosa",
    });
    assert.match(body, /day 1 of 2/);
    assert.match(body, /99 · 1× Dosa/);
    assert.match(body, /Week cart chk/);
  });
});
