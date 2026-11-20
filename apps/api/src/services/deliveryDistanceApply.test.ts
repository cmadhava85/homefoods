import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSelfDeliveryAllowed,
  resolveSelfDeliveryPaise,
} from "@localmeals/domain";

/**
 * Mirrors applyDeliveryDistancePaise in orders.ts — flag off keeps flat fee;
 * flag on free/paid/block. Full HTTP create needs DB fixtures + coords.
 */
describe("delivery distance apply (API contract)", () => {
  const cook = { cookLat: "12.901", cookLng: "80.227" };

  it("flag off ignores distance and keeps flat fee", () => {
    const r = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: false,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      ...cook,
      addressLat: "13.2",
      addressLng: "80.2",
    });
    assert.equal(r.band, "FLAT");
    assert.equal(r.deliveryPaise, 2500);
    assert.doesNotThrow(() => assertSelfDeliveryAllowed(r.band));
  });

  it("flag on free within 3 km", () => {
    const r = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: true,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      ...cook,
      addressLat: "12.905",
      addressLng: "80.230",
    });
    assert.equal(r.band, "FREE");
    assert.equal(r.deliveryPaise, 0);
  });

  it("flag on rejects beyond 5 km and missing coords", () => {
    const far = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: true,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      ...cook,
      addressLat: "13.05",
      addressLng: "80.227",
    });
    assert.equal(far.band, "TOO_FAR");
    assert.throws(() => assertSelfDeliveryAllowed(far.band), /5 km/);

    const missing = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: true,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      ...cook,
      addressLat: null,
      addressLng: null,
    });
    assert.equal(missing.band, "MISSING_COORDS");
    assert.throws(() => assertSelfDeliveryAllowed(missing.band), /not available/);
  });
});
