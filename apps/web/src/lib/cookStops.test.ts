import { describe, expect, it } from "vitest";
import { cookStopGroupKey, groupCookStops } from "./cookStops";

describe("groupCookStops", () => {
  it("clubs same phone + address + mode", () => {
    const groups = groupCookStops([
      {
        id: 1,
        customerMobile: "+9191",
        deliveryTargetAddress: "Tower 3",
        fulfillmentMode: "DELIVERY",
        qty: 1,
        status: "PAID",
      },
      {
        id: 2,
        customerMobile: "+9191",
        deliveryTargetAddress: "Tower 3",
        fulfillmentMode: "DELIVERY",
        qty: 2,
        status: "PAID",
      },
      {
        id: 3,
        customerMobile: "+9191",
        deliveryTargetAddress: "Office",
        fulfillmentMode: "DELIVERY",
        qty: 1,
        status: "PAID",
      },
    ]);
    expect(groups).toHaveLength(2);
    const home = groups.find((g) => g.deliveryTargetAddress === "Tower 3");
    expect(home?.orders).toHaveLength(2);
    expect(home?.totalQty).toBe(3);
  });

  it("separates pickup from delivery", () => {
    expect(
      cookStopGroupKey({
        id: 1,
        customerMobile: "+91",
        deliveryTargetAddress: "X",
        fulfillmentMode: "DELIVERY",
        qty: 1,
        status: "PAID",
      }),
    ).not.toBe(
      cookStopGroupKey({
        id: 2,
        customerMobile: "+91",
        deliveryTargetAddress: "X",
        fulfillmentMode: "PICKUP",
        qty: 1,
        status: "PAID",
      }),
    );
  });
});
