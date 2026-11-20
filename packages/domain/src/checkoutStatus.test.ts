import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateCheckoutStatus } from "./checkoutStatus.js";

describe("aggregateCheckoutStatus", () => {
  it("prefers pay states over cancelled first day", () => {
    assert.equal(
      aggregateCheckoutStatus(["CANCELLED", "AWAITING_PAYMENT"]),
      "AWAITING_PAYMENT",
    );
  });

  it("does not let day-1 refund hide later paid lines", () => {
    assert.equal(aggregateCheckoutStatus(["REFUNDED", "PAID", "PAID"]), "PAID");
    assert.equal(aggregateCheckoutStatus(["CANCELLED", "COOKING"]), "COOKING");
  });

  it("picks furthest kitchen progress", () => {
    assert.equal(aggregateCheckoutStatus(["PAID", "PACKED", "COOKING"]), "PACKED");
    assert.equal(aggregateCheckoutStatus(["DISPATCHED", "PAID"]), "DISPATCHED");
  });

  it("all cancelled / all refunded / all delivered", () => {
    assert.equal(aggregateCheckoutStatus(["CANCELLED", "CANCELLED"]), "CANCELLED");
    assert.equal(aggregateCheckoutStatus(["REFUNDED", "REFUNDED"]), "REFUNDED");
    assert.equal(aggregateCheckoutStatus(["DELIVERED", "DELIVERED"]), "DELIVERED");
  });

  it("mixed terminal prefers delivered then refunded", () => {
    assert.equal(aggregateCheckoutStatus(["CANCELLED", "DELIVERED"]), "DELIVERED");
    assert.equal(aggregateCheckoutStatus(["CANCELLED", "REFUNDED"]), "REFUNDED");
  });
});
