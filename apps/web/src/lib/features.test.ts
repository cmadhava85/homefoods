import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFeatureFlags } from "@localmeals/domain";
import { flagOn, loadFeatureFlags } from "./features";

describe("flagOn", () => {
  it("treats missing keys as on and explicit false as off", () => {
    const flags = defaultFeatureFlags();
    expect(flagOn(flags, "ordering_enabled")).toBe(true);
    expect(flagOn({ ...flags, ordering_enabled: false }, "ordering_enabled")).toBe(false);
    expect(flagOn({ ...flags, pickup_enabled: false }, "pickup_enabled")).toBe(false);
    expect(flagOn({ ...flags, pickup_enabled: true }, "pickup_enabled")).toBe(true);
  });
});

describe("loadFeatureFlags", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("dedupes concurrent fetches into one network call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ flags: { ordering_enabled: false } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([loadFeatureFlags(), loadFeatureFlags()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.ordering_enabled).toBe(false);
    expect(b.ordering_enabled).toBe(false);
  });
});
