import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertCustomerOwnsCheckout,
  assertCustomerOwnsOrder,
  mobileOwnsOrder,
} from "./orderOwnership.js";

describe("orderOwnership", () => {
  const order = {
    customerMobile: "+919111111111",
    payerMobile: "+919222222222",
  };

  it("owner and payer own the order", () => {
    assert.equal(mobileOwnsOrder(order, "+919111111111"), true);
    assert.equal(mobileOwnsOrder(order, "+919222222222"), true);
    assert.equal(mobileOwnsOrder(order, "+919333333333"), false);
    assert.doesNotThrow(() => assertCustomerOwnsOrder(order, "+919111111111"));
    assert.throws(() => assertCustomerOwnsOrder(order, "+919000000000"), /Not your order/);
  });

  it("checkout seed uses same ownership", () => {
    assert.doesNotThrow(() => assertCustomerOwnsCheckout(order, "+919222222222"));
    assert.throws(() => assertCustomerOwnsCheckout(null, "+919111111111"), /Checkout not found/);
    assert.throws(() => assertCustomerOwnsCheckout(order, "+919000000000"), /Not your order/);
  });
});
