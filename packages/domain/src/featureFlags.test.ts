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
    assert.equal(d.ordering_enabled, true);
    assert.equal(d.reviews_enabled, true);
  });

  it("respects explicit off and null maps", () => {
    assert.equal(isFeatureEnabled({ ordering_enabled: false }, "ordering_enabled"), false);
    assert.equal(isFeatureEnabled({}, "reviews_enabled"), true);
    assert.equal(isFeatureEnabled({}, "pickup_enabled"), false);
    assert.equal(isFeatureEnabled(null, "ordering_enabled"), true);
    assert.equal(isFeatureEnabled(undefined, "pickup_enabled"), false);
    assert.equal(isFeatureEnabled({ ordering_enabled: true }, "ordering_enabled"), true);
  });
});
