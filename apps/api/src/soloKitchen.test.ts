import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  isSoloKitchenMode,
  platformFeePaise,
  platformFeePaiseForCheckoutLine,
  soloKitchenSlug,
} from "./soloKitchen.js";

const KEYS = ["SOLO_KITCHEN_SLUG", "NEXT_PUBLIC_SOLO_KITCHEN_SLUG"] as const;
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

describe("soloKitchen (api)", () => {
  it("is off by default with normal ₹7 fee", () => {
    assert.equal(soloKitchenSlug(), null);
    assert.equal(isSoloKitchenMode(), false);
    assert.equal(platformFeePaise(), 700);
    assert.equal(platformFeePaiseForCheckoutLine(0), 700);
    assert.equal(platformFeePaiseForCheckoutLine(1), 0);
  });

  it("accepts a valid slug and zeros platform fee", () => {
    process.env.SOLO_KITCHEN_SLUG = "csk-homemade-delights";
    assert.equal(soloKitchenSlug(), "csk-homemade-delights");
    assert.equal(isSoloKitchenMode(), true);
    assert.equal(platformFeePaise(), 0);
    assert.equal(platformFeePaiseForCheckoutLine(0), 0);
  });

  it("falls back to NEXT_PUBLIC_SOLO_KITCHEN_SLUG", () => {
    process.env.NEXT_PUBLIC_SOLO_KITCHEN_SLUG = "csk-homemade-delights";
    assert.equal(soloKitchenSlug(), "csk-homemade-delights");
    assert.equal(platformFeePaise(), 0);
  });

  it("rejects invalid slugs", () => {
    process.env.SOLO_KITCHEN_SLUG = "No Spaces!";
    assert.equal(soloKitchenSlug(), null);
  });
});
