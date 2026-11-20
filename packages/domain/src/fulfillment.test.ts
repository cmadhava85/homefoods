import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertFulfillmentAllowed,
  assertFulfillmentOffersValid,
  assertIntakeOpen,
  cookFulfillmentOffersFromRow,
  isIntakePausedForDate,
  isZeroDeliveryFulfillment,
  normalizeFulfillmentMode,
} from "./fulfillment.js";

describe("fulfillment helpers", () => {
  it("normalizes modes and zero-delivery", () => {
    assert.equal(normalizeFulfillmentMode("PICKUP"), "PICKUP");
    assert.equal(normalizeFulfillmentMode("CUSTOMER_ARRANGE"), "CUSTOMER_ARRANGE");
    assert.equal(normalizeFulfillmentMode(null), "DELIVERY");
    assert.equal(isZeroDeliveryFulfillment("PICKUP"), true);
    assert.equal(isZeroDeliveryFulfillment("CUSTOMER_ARRANGE"), true);
    assert.equal(isZeroDeliveryFulfillment("DELIVERY"), false);
  });

  it("pause is date-scoped", () => {
    assert.equal(isIntakePausedForDate("2026-11-18", "2026-11-18"), true);
    assert.equal(isIntakePausedForDate("2026-11-18", "2026-11-19"), false);
    assert.equal(isIntakePausedForDate(null, "2026-11-18"), false);
    assert.throws(() => assertIntakeOpen("2026-11-18", "2026-11-18"), /paused intake/i);
    assert.doesNotThrow(() => assertIntakeOpen("2026-11-18", "2026-11-19"));
  });

  it("requires at least one offer", () => {
    assert.throws(
      () =>
        assertFulfillmentOffersValid({
          cookDelivery: false,
          pickup: false,
          customerArrange: false,
        }),
      /at least one/i,
    );
    assert.doesNotThrow(() =>
      assertFulfillmentOffersValid({
        cookDelivery: true,
        pickup: false,
        customerArrange: false,
      }),
    );
  });

  it("gates checkout mode against offers", () => {
    const offers = cookFulfillmentOffersFromRow({
      offerCookDelivery: true,
      pickupEnabled: true,
      offerCustomerArrange: false,
    });
    assert.deepEqual(offers, {
      cookDelivery: true,
      pickup: true,
      customerArrange: false,
    });
    assert.doesNotThrow(() => assertFulfillmentAllowed("DELIVERY", offers));
    assert.doesNotThrow(() =>
      assertFulfillmentAllowed("PICKUP", offers, { pickupPlatformAvailable: true }),
    );
    assert.throws(
      () => assertFulfillmentAllowed("CUSTOMER_ARRANGE", offers),
      /customer-arranged/i,
    );
  });
});
