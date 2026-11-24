import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allocateCredit,
  buildIdempotencyKey,
  convenienceFeePaise,
  lineGatewayPaise,
  lineTotalPaise,
  priceCheckoutLines,
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
    assert.equal(
      buildIdempotencyKey({ ...base, spice: undefined }),
      "std|+9198|c1|LUNCH|2026-11-05|10800|1||delivery",
    );
  });
});

describe("convenience fee + credit", () => {
  it("grosses up so the merchant nets the base after Razorpay's cut", () => {
    for (const [base, bps] of [[8400, 236], [10_000, 236], [8400, 117], [1, 236]] as const) {
      const fee = convenienceFeePaise(base, bps);
      const charged = base + fee;
      const net = charged - Math.ceil((charged * bps) / 10_000);
      assert.ok(net >= base - 1 && net <= base + 1, `${base}@${bps}: net ${net}`);
    }
    assert.equal(convenienceFeePaise(8400, 236), 204); // ₹84 lunch → ₹2.04
    assert.equal(convenienceFeePaise(0, 236), 0);
    assert.equal(convenienceFeePaise(8400, 0), 0);
  });

  it("spends credit earliest line first and charges fee only on the gateway part", () => {
    assert.deepEqual(allocateCredit([500, 500, 500], 700), [500, 200, 0]);
    const priced = priceCheckoutLines([500, 500], { creditAvailablePaise: 600, feeBps: 236 });
    assert.deepEqual(priced[0], { creditAppliedPaise: 500, convenienceFeePaise: 0, gatewayPaise: 0 });
    assert.equal(priced[1].creditAppliedPaise, 100);
    assert.equal(priced[1].gatewayPaise, 400 + convenienceFeePaise(400, 236));
  });

  it("line totals include the fee; the gateway part excludes credit", () => {
    const line = { foodPaise: 8000, qty: 1, deliveryPaise: 0, platformFeePaise: 700, convenienceFeePaise: 100, creditAppliedPaise: 300 };
    assert.equal(lineTotalPaise(line), 8800);
    assert.equal(lineGatewayPaise(line), 8500);
    assert.equal(lineGatewayPaise({ ...line, creditAppliedPaise: 9999 }), 0);
  });
});
