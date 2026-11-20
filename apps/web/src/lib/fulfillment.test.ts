import { describe, expect, it } from "vitest";
import { resolveEffectiveFulfillment, showFulfillmentChooser } from "./fulfillment";

describe("resolveEffectiveFulfillment", () => {
  it("honours available modes and falls back", () => {
    expect(
      resolveEffectiveFulfillment("PICKUP", { cookDelivery: true, pickup: true }, true),
    ).toBe("PICKUP");
    expect(
      resolveEffectiveFulfillment(
        "CUSTOMER_ARRANGE",
        { cookDelivery: false, pickup: false, customerArrange: true },
        false,
      ),
    ).toBe("CUSTOMER_ARRANGE");
    expect(
      resolveEffectiveFulfillment(
        "DELIVERY",
        { cookDelivery: false, pickup: true, customerArrange: false },
        true,
      ),
    ).toBe("PICKUP");
  });

  it("shows chooser only when more than one path", () => {
    expect(showFulfillmentChooser({ cookDelivery: true }, false)).toBe(false);
    expect(showFulfillmentChooser({ cookDelivery: true, customerArrange: true }, false)).toBe(
      true,
    );
  });
});
