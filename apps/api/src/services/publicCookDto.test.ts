import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { httpIdempotencyKey, publicCookDto } from "./orders.js";

describe("publicCookDto", () => {
  it("never surfaces cook mobile or payout rails", () => {
    const cook = {
      id: "cook-1",
      kitchenName: "Amma Kitchen",
      slugHandle: "amma",
      pinCode: "600119",
      lat: "12.9",
      lng: "80.2",
      deliveryType: "SELF",
      flatSelfDeliveryFee: "25.00",
      fssaiNumber: "123",
      fssaiVerifiedAt: new Date(),
      weekDiscountPercent: 5,
      weekDiscountMinDays: 3,
      pickupEnabled: true,
      // Sensitive fields that must not leak via spread mistakes
      mobileNumber: "+919876543211",
      payoutUpiId: "amma@upi",
      payoutAccountNote: "HDFC ****1234",
      payoutBeneficiaryRef: "acc_secret",
      onboardingStatus: "LIVE",
      isActive: true,
    };
    const dto = publicCookDto(cook);
    const json = JSON.stringify(dto);
    assert.equal("mobileNumber" in dto, false);
    assert.equal("payoutUpiId" in dto, false);
    assert.equal("payoutAccountNote" in dto, false);
    assert.equal("payoutBeneficiaryRef" in dto, false);
    assert.doesNotMatch(json, /\+919876543211/);
    assert.doesNotMatch(json, /amma@upi/);
    assert.doesNotMatch(json, /acc_secret/);
    assert.equal(dto.kitchenName, "Amma Kitchen");
    assert.equal(dto.slugHandle, "amma");
    assert.equal(dto.pinCode, "600119");
  });
});

describe("httpIdempotencyKey", () => {
  it("scopes keys to the customer mobile", () => {
    const a = httpIdempotencyKey("+919111111111", "cart-1");
    const b = httpIdempotencyKey("+919222222222", "cart-1");
    assert.notEqual(a, b);
    assert.match(a, /^hdr\|/);
    assert.equal(httpIdempotencyKey("+919111111111", "cart-1"), a);
  });

  it("rejects empty keys", () => {
    assert.throws(() => httpIdempotencyKey("+919111111111", "  "), /empty/);
  });
});
