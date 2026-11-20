import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cookStopGroupKey, groupCookStops } from "./cookStops.js";

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
    assert.equal(groups.length, 2);
    const home = groups.find((g) => g.deliveryTargetAddress === "Tower 3");
    assert.equal(home?.orders.length, 2);
    assert.equal(home?.totalQty, 3);
  });

  it("separates pickup from delivery", () => {
    assert.notEqual(
      cookStopGroupKey({
        id: 1,
        customerMobile: "+91",
        deliveryTargetAddress: "X",
        fulfillmentMode: "DELIVERY",
        qty: 1,
        status: "PAID",
      }),
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
