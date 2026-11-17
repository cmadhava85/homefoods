import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertCanAcceptPaidOrders,
  canAcceptPaidOrders,
  hasCookPayoutDetails,
} from "./cookGates.js";

describe("cook LIVE/FSSAI gates", () => {
  const live = {
    onboardingStatus: "LIVE" as const,
    fssaiNumber: "10012345678901",
    isActive: true,
    payoutUpiId: "cook@upi",
  };

  it("allows LIVE + FSSAI + active + UPI", () => {
    assert.equal(canAcceptPaidOrders(live), true);
    assertCanAcceptPaidOrders(live);
  });

  it("blocks DOCS_SUBMITTED / missing FSSAI / inactive", () => {
    assert.equal(
      canAcceptPaidOrders({ ...live, onboardingStatus: "DOCS_SUBMITTED" }),
      false,
    );
    assert.equal(canAcceptPaidOrders({ ...live, fssaiNumber: null }), false);
    assert.equal(canAcceptPaidOrders({ ...live, fssaiNumber: "  " }), false);
    assert.equal(canAcceptPaidOrders({ ...live, isActive: false }), false);
  });

  it("requires UPI, bank note, or Route", () => {
    assert.equal(hasCookPayoutDetails({ ...live, payoutUpiId: null }), false);
    assert.equal(
      canAcceptPaidOrders({
        ...live,
        payoutUpiId: null,
        payoutAccountNote: null,
        payoutBeneficiaryRef: null,
      }),
      false,
    );
    assert.equal(
      canAcceptPaidOrders({
        ...live,
        payoutUpiId: null,
        payoutBeneficiaryRef: "acc_x",
      }),
      true,
    );
    assert.equal(
      canAcceptPaidOrders({
        ...live,
        payoutUpiId: null,
        payoutAccountNote: "HDFC · IFSC · Amma",
      }),
      true,
    );
  });

  it("treats whitespace-only payout fields as missing", () => {
    assert.equal(
      hasCookPayoutDetails({
        ...live,
        payoutUpiId: "   ",
        payoutAccountNote: "  ",
        payoutBeneficiaryRef: "\t",
      }),
      false,
    );
    assert.equal(
      canAcceptPaidOrders({
        ...live,
        payoutUpiId: "   ",
        payoutAccountNote: null,
        payoutBeneficiaryRef: null,
      }),
      false,
    );
  });

  it("assert throws with clear message", () => {
    assert.throws(
      () => assertCanAcceptPaidOrders({ ...live, isActive: false }),
      /LIVE|FSSAI|payout/i,
    );
  });
});
