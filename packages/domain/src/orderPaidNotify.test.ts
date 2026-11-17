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
  cookSlug: "sri-sai",
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
    assert.match(body, /New PAID Lunch order/);
    assert.match(body, /For 2026-11-18/);
    assert.doesNotMatch(body, /Week cart/);
    assert.doesNotMatch(body, /day \d+ of/);
  });

  it("cook WA marks week-cart day ordinal and checkout id", () => {
    const body = formatOrderPaidCookWa(weekDay2);
    assert.match(body, /New PAID Lunch · day 2 of 3/);
    assert.match(body, /For 2026-11-19/);
    assert.match(body, /Week cart chk_week1/);
    assert.match(body, /that day only/);
  });

  it("customer WA explains per-day cooking on week cart", () => {
    const body = formatOrderPaidCustomerWa(weekDay2);
    assert.match(body, /For 2026-11-19/);
    assert.match(body, /Week cart chk_week1 · day 2 of 3/);
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
});
