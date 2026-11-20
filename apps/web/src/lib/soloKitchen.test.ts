import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hideCookOnboard,
  isSoloKitchenMode,
  kitchensBrowseHref,
  platformFeePaise,
  soloKitchenSlug,
} from "./soloKitchen";

const KEYS = [
  "NEXT_PUBLIC_SOLO_KITCHEN_SLUG",
  "SOLO_KITCHEN_SLUG",
  "NEXT_PUBLIC_HIDE_COOK_ONBOARD",
] as const;

const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("soloKitchen", () => {
  it("is off by default", () => {
    expect(soloKitchenSlug()).toBeNull();
    expect(isSoloKitchenMode()).toBe(false);
    expect(kitchensBrowseHref()).toBe("/discover");
    expect(hideCookOnboard()).toBe(false);
    expect(platformFeePaise()).toBe(700);
  });

  it("routes browse to the solo kitchen and hides onboard", () => {
    process.env.NEXT_PUBLIC_SOLO_KITCHEN_SLUG = "csk-homemade-delights";
    expect(soloKitchenSlug()).toBe("csk-homemade-delights");
    expect(isSoloKitchenMode()).toBe(true);
    expect(kitchensBrowseHref()).toBe("/kitchen/csk-homemade-delights");
    expect(hideCookOnboard()).toBe(true);
    expect(platformFeePaise()).toBe(0);
  });

  it("rejects invalid slugs", () => {
    process.env.NEXT_PUBLIC_SOLO_KITCHEN_SLUG = "../evil";
    expect(soloKitchenSlug()).toBeNull();
  });

  it("can hide onboard without solo slug", () => {
    process.env.NEXT_PUBLIC_HIDE_COOK_ONBOARD = "true";
    expect(hideCookOnboard()).toBe(true);
    expect(kitchensBrowseHref()).toBe("/discover");
  });
});
