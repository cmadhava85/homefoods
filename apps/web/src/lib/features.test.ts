import { describe, expect, it } from "vitest";
import { defaultFeatureFlags } from "@localmeals/domain";
import { flagOn } from "./features";

describe("flagOn", () => {
  it("treats missing keys as on and explicit false as off", () => {
    const flags = defaultFeatureFlags();
    expect(flagOn(flags, "ordering_enabled")).toBe(true);
    expect(flagOn({ ...flags, ordering_enabled: false }, "ordering_enabled")).toBe(false);
    expect(flagOn({ ...flags, pickup_enabled: false }, "pickup_enabled")).toBe(false);
    expect(flagOn({ ...flags, pickup_enabled: true }, "pickup_enabled")).toBe(true);
  });
});
