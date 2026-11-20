import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FREE_SELF_DELIVERY_KM,
  MAX_SELF_DELIVERY_KM,
  assertSelfDeliveryAllowed,
  haversineKm,
  parseLatLng,
  resolveAddressLatLng,
  resolveSelfDeliveryPaise,
  selfDeliveryBand,
} from "./deliveryDistance.js";

describe("delivery distance", () => {
  it("parses valid coords and rejects junk", () => {
    assert.deepEqual(parseLatLng("12.9", "80.2"), { lat: 12.9, lng: 80.2 });
    assert.equal(parseLatLng(null, "80"), null);
    assert.equal(parseLatLng("91", "0"), null);
  });

  it("haversine is ~0 for same point and positive for neighbours", () => {
    const a = { lat: 12.901, lng: 80.227 };
    assert.ok(haversineKm(a, a) < 0.001);
    const near = { lat: 12.91, lng: 80.23 };
    const d = haversineKm(a, near);
    assert.ok(d > 0.5 && d < 3);
  });

  it("bands free / paid / too far", () => {
    assert.equal(selfDeliveryBand(0), "FREE");
    assert.equal(selfDeliveryBand(FREE_SELF_DELIVERY_KM), "FREE");
    assert.equal(selfDeliveryBand(FREE_SELF_DELIVERY_KM + 0.1), "PAID");
    assert.equal(selfDeliveryBand(MAX_SELF_DELIVERY_KM), "PAID");
    assert.equal(selfDeliveryBand(MAX_SELF_DELIVERY_KM + 0.01), "TOO_FAR");
    assert.equal(selfDeliveryBand(null), "MISSING_COORDS");
  });

  it("flag off keeps flat fee; pickup is zero", () => {
    assert.deepEqual(
      resolveSelfDeliveryPaise({
        distanceLimitsEnabled: false,
        fulfillmentMode: "DELIVERY",
        flatSelfDeliveryFeePaise: 2500,
        cookLat: "12.9",
        cookLng: "80.2",
        addressLat: "13.5",
        addressLng: "80.2",
      }),
      { deliveryPaise: 2500, band: "FLAT", distanceKm: null },
    );
    assert.equal(
      resolveSelfDeliveryPaise({
        distanceLimitsEnabled: true,
        fulfillmentMode: "PICKUP",
        flatSelfDeliveryFeePaise: 2500,
      }).deliveryPaise,
      0,
    );
  });

  it("falls back to pin centroid when address GPS missing", () => {
    const r = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: true,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      cookLat: "12.901",
      cookLng: "80.227",
      addressLat: null,
      addressLng: null,
      addressPinCode: "600119",
    });
    assert.equal(r.band, "FREE");
    assert.ok(r.distanceKm != null && r.distanceKm < 1);
  });

  it("flag on: free / paid / too far / missing coords", () => {
    const cook = { cookLat: "12.901", cookLng: "80.227" };
    const pin = { addressPinCode: "600119" };
    const free = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: true,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      ...cook,
      ...pin,
      addressLat: "12.905",
      addressLng: "80.230",
    });
    assert.equal(free.band, "FREE");
    assert.equal(free.deliveryPaise, 0);
    assert.ok(free.distanceKm != null && free.distanceKm <= FREE_SELF_DELIVERY_KM);

    const paid = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: true,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      ...cook,
      ...pin,
      // ~4 km north of kitchen (still within PIN drift)
      addressLat: "12.937",
      addressLng: "80.227",
    });
    assert.equal(paid.band, "PAID");
    assert.equal(paid.deliveryPaise, 2500);

    const far = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: true,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      ...cook,
      ...pin,
      // ~6 km north — within PIN drift, beyond max delivery
      addressLat: "12.955",
      addressLng: "80.227",
    });
    assert.equal(far.band, "TOO_FAR");

    // GPS beyond PIN drift → fall back to centroid (near cook) → FREE, not spoofed far band
    const drifted = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: true,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      ...cook,
      ...pin,
      addressLat: "13.05",
      addressLng: "80.227",
    });
    assert.equal(drifted.band, "FREE");

    const missing = resolveSelfDeliveryPaise({
      distanceLimitsEnabled: true,
      fulfillmentMode: "DELIVERY",
      flatSelfDeliveryFeePaise: 2500,
      ...cook,
      addressLat: null,
      addressLng: null,
    });
    assert.equal(missing.band, "MISSING_COORDS");
    assert.throws(() => assertSelfDeliveryAllowed("TOO_FAR"), /5 km/);
    assert.throws(() => assertSelfDeliveryAllowed("MISSING_COORDS"), /not available/);
  });

  it("rejects client GPS without known PIN; clamps spoofed GPS to PIN centroid", () => {
    assert.equal(
      resolveAddressLatLng({ lat: "12.901", lng: "80.227", pinCode: "110001" }),
      null,
    );
    const spoofNearCook = resolveAddressLatLng({
      lat: "12.901",
      lng: "80.227",
      pinCode: "600119",
    });
    assert.ok(spoofNearCook);
    assert.ok(haversineKm(spoofNearCook!, { lat: 12.901, lng: 80.227 }) < 1);

    const farGps = resolveAddressLatLng({
      lat: "13.5",
      lng: "80.227",
      pinCode: "600119",
    });
    assert.deepEqual(farGps, { lat: 12.901, lng: 80.227 });
  });
});
