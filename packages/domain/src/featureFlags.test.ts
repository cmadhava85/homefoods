import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultFeatureFlags,
  isFeatureEnabled,
  FEATURE_FLAG_DEFS,
} from "./featureFlags.js";

describe("feature flags", () => {
  it("defaults match FEATURE_FLAG_DEFS", () => {
    const d = defaultFeatureFlags();
    assert.equal(FEATURE_FLAG_DEFS.length, Object.keys(d).length);
    for (const def of FEATURE_FLAG_DEFS) {
      assert.equal(d[def.key], def.defaultEnabled, def.key);
      assert.ok(def.label.length > 0, def.key);
      assert.ok(def.description.length > 0, def.key);
    }
    assert.equal(d.pickup_enabled, false);
    assert.equal(d.lean_wa_status_enabled, false);
    assert.equal(d.delivery_distance_limits_enabled, false);
    assert.equal(d.self_delivery_fee_enabled, false);
    assert.equal(d.child_pays_enabled, false);
    assert.equal(d.ads_enabled, false);
    assert.equal(d.ordering_enabled, true);
    assert.equal(d.reviews_enabled, true);
  });

  it("ads_enabled stays off unless explicitly enabled", () => {
    assert.equal(isFeatureEnabled({}, "ads_enabled"), false);
    assert.equal(isFeatureEnabled(null, "ads_enabled"), false);
    assert.equal(isFeatureEnabled({ ads_enabled: true }, "ads_enabled"), true);
  });

  it("respects explicit off and null maps", () => {
    assert.equal(isFeatureEnabled({ ordering_enabled: false }, "ordering_enabled"), false);
    assert.equal(isFeatureEnabled({}, "reviews_enabled"), true);
    assert.equal(isFeatureEnabled({}, "pickup_enabled"), false);
    assert.equal(isFeatureEnabled(null, "ordering_enabled"), true);
    assert.equal(isFeatureEnabled(undefined, "pickup_enabled"), false);
    assert.equal(isFeatureEnabled({ ordering_enabled: true }, "ordering_enabled"), true);
  });

  it("ignores non-boolean flag values and unknown keys", () => {
    assert.equal(
      isFeatureEnabled(
        { ordering_enabled: "yes" as unknown as boolean },
        "ordering_enabled",
      ),
      true,
    );
    assert.equal(
      isFeatureEnabled({ pickup_enabled: 0 as unknown as boolean }, "pickup_enabled"),
      false,
    );
    assert.equal(
      isFeatureEnabled({}, "not_a_real_flag" as typeof FEATURE_FLAG_DEFS[number]["key"]),
      true,
    );
  });
});
