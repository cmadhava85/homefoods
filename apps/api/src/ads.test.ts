import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultFeatureFlags, isFeatureEnabled } from "@localmeals/domain";

describe("ads feature gate", () => {
  it("defaults ads_enabled to false so Discover stays organic", () => {
    const flags = defaultFeatureFlags();
    assert.equal(flags.ads_enabled, false);
    assert.equal(isFeatureEnabled(flags, "ads_enabled"), false);
  });
});
