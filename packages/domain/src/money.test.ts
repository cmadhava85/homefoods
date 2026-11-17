import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildIdempotencyKey,
  orderTotalPaise,
  paiseToRupees,
  platformFeePaiseForCheckoutLine,
  rupeesToPaise,
} from "./money.js";

describe("money", () => {
  it("charges platform fee once per checkout (first day-line only)", () => {
    assert.equal(platformFeePaiseForCheckoutLine(0), 700);
    assert.equal(platformFeePaiseForCheckoutLine(1), 0);
    assert.equal(platformFeePaiseForCheckoutLine(4), 0);
  });

  it("totals food × qty + delivery + platform fee", () => {
    assert.equal(
      orderTotalPaise({ foodPaise: 8000, deliveryPaise: 2500, platformFeePaise: 700, qty: 2 }),
      19200,
    );
    assert.equal(
      orderTotalPaise({ foodPaise: 7000, deliveryPaise: 0, platformFeePaise: 700, qty: 1 }),
      7700,
    );
    assert.equal(
      orderTotalPaise({
        foodPaise: 8000,
        deliveryPaise: 2500,
        platformFeePaise: 700,
        qty: 2,
        foodDiscountPaise: 1600,
      }),
      17600,
    );
  });

  it("converts rupees ↔ paise", () => {
    assert.equal(rupeesToPaise(80), 8000);
    assert.equal(rupeesToPaise(25.5), 2550);
    assert.equal(paiseToRupees(10800), 108);
  });

  it("idempotency key distinguishes menu, spice, late, fulfillment", () => {
    const base = {
      customerMobile: "+9198",
      cookId: "c1",
      mealType: "LUNCH",
      serviceDate: "2026-11-05",
      amountPaise: 10800,
      menuItemId: 1,
      spice: "NORMAL",
    };
    const a = buildIdempotencyKey(base);
    const b = buildIdempotencyKey(base);
    assert.equal(a, b);
    assert.notEqual(a, buildIdempotencyKey({ ...base, spice: "LESS" }));
    assert.notEqual(a, buildIdempotencyKey({ ...base, menuItemId: 2 }));
    assert.notEqual(a, buildIdempotencyKey({ ...base, late: true }));
    assert.notEqual(
      a,
      buildIdempotencyKey({ ...base, fulfillmentMode: "PICKUP" }),
    );
    assert.match(a, /^std\|/);
    assert.match(a, /\|delivery$/);
    assert.match(
      buildIdempotencyKey({ ...base, fulfillmentMode: "PICKUP" }),
      /\|pickup$/,
    );
    assert.match(buildIdempotencyKey({ ...base, late: true }), /^late\|/);
    const noMenu = buildIdempotencyKey({ ...base, menuItemId: undefined });
    assert.notEqual(a, noMenu);
    assert.ok(noMenu.includes("||"));
  });
});
