import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateTurnoverFromRows,
  resolveTurnoverRange,
} from "./turnoverReports.js";

describe("resolveTurnoverRange", () => {
  it("week is 7 days ending asOf", () => {
    const r = resolveTurnoverRange({ period: "week", asOf: "2026-11-16" });
    assert.equal(r.from, "2026-11-10");
    assert.equal(r.to, "2026-11-16");
    assert.equal(r.period, "week");
  });

  it("month starts on the 1st", () => {
    const r = resolveTurnoverRange({ period: "month", asOf: "2026-11-16" });
    assert.equal(r.from, "2026-11-01");
    assert.equal(r.to, "2026-11-16");
  });

  it("year starts Jan 1", () => {
    const r = resolveTurnoverRange({ period: "year", asOf: "2026-11-16" });
    assert.equal(r.from, "2026-01-01");
    assert.equal(r.to, "2026-11-16");
  });

  it("custom uses from/to", () => {
    const r = resolveTurnoverRange({
      period: "custom",
      from: "2026-01-01",
      to: "2026-03-31",
    });
    assert.equal(r.from, "2026-01-01");
    assert.equal(r.to, "2026-03-31");
  });

  it("custom defaults to ~30 days when from/to omitted", () => {
    const r = resolveTurnoverRange({ period: "custom", asOf: "2026-11-16" });
    assert.equal(r.to, "2026-11-16");
    assert.equal(r.from, "2026-10-18");
  });

  it("rejects inverted custom range", () => {
    assert.throws(
      () =>
        resolveTurnoverRange({
          period: "custom",
          from: "2026-12-01",
          to: "2026-01-01",
        }),
      /from must be/,
    );
  });
});

describe("aggregateTurnoverFromRows", () => {
  const cooks = [
    {
      id: "c1",
      kitchenName: "Alpha",
      slugHandle: "alpha",
      onboardingStatus: "LIVE",
      isActive: true,
      pinCode: "600119",
      payoutBeneficiaryRef: "acc_1",
      payoutUpiId: "a@upi",
    },
    {
      id: "c2",
      kitchenName: "Beta",
      slugHandle: "beta",
      onboardingStatus: "LIVE",
      isActive: true,
      pinCode: "600119",
      payoutBeneficiaryRef: null,
      payoutUpiId: null,
    },
  ];

  it("sums GMV, fees, plates and sorts by food GMV", () => {
    const { cooks: rows, platform } = aggregateTurnoverFromRows(
      [
        {
          cookId: "c1",
          foodPaise: 8000,
          foodDiscountPaise: 0,
          deliveryPaise: 2500,
          platformFeePaise: 700,
          qty: 2,
          status: "DELIVERED",
          settlementHold: false,
        },
        {
          cookId: "c2",
          foodPaise: 5000,
          foodDiscountPaise: 500,
          deliveryPaise: 0,
          platformFeePaise: 700,
          qty: 1,
          status: "PAID",
          settlementHold: true,
        },
      ],
      [],
      cooks,
    );
    assert.equal(rows[0].cookId, "c1");
    assert.equal(rows[0].foodGmvPaise, 16000);
    assert.equal(rows[0].plates, 2);
    assert.equal(rows[0].deliveredOrderCount, 1);
    assert.equal(rows[0].customerChargePaise, 16000 + 2500 + 700);
    assert.equal(rows[1].foodGmvPaise, 4500);
    assert.equal(rows[1].heldOrderCount, 1);
    assert.equal(platform.foodGmvPaise, 20500);
    assert.equal(platform.cookCountWithVolume, 2);
  });

  it("tracks refunds separately from GMV", () => {
    const { cooks: rows, platform } = aggregateTurnoverFromRows(
      [
        {
          cookId: "c1",
          foodPaise: 8000,
          foodDiscountPaise: 0,
          deliveryPaise: 0,
          platformFeePaise: 700,
          qty: 1,
          status: "REFUNDED",
          settlementHold: false,
        },
      ],
      [],
      cooks,
    );
    assert.equal(rows[0].foodGmvPaise, 0);
    assert.equal(rows[0].refundedFoodPaise, 8000);
    assert.equal(rows[0].refundedOrderCount, 1);
    assert.equal(platform.refundedFoodPaise, 8000);
    assert.equal(platform.cookCountWithVolume, 0);
  });

  it("applies settlement manual and Route buckets", () => {
    const { cooks: rows, platform } = aggregateTurnoverFromRows(
      [],
      [
        {
          cookId: "c1",
          netPaise: 10000,
          feesPaise: 500,
          orderCount: 2,
          status: "MANUAL_PAID",
          manualPaidAt: new Date(),
        },
        {
          cookId: "c2",
          netPaise: 5000,
          orderCount: 1,
          status: "TRANSFER_COMPLETED",
          manualPaidAt: null,
        },
      ],
      cooks,
    );
    assert.equal(rows.find((r) => r.cookId === "c1")!.manualPaidPaise, 10000);
    assert.equal(rows.find((r) => r.cookId === "c2")!.transferCompletedPaise, 5000);
    assert.equal(platform.settledNetPaise, 15000);
    assert.equal(rows.find((r) => r.cookId === "c1")!.commissionPaise, 500);
    assert.equal(platform.commissionPaise, 500);
    assert.equal(platform.cookCountWithVolume, 2);
  });

  it("ignores non-GMV statuses", () => {
    const { platform } = aggregateTurnoverFromRows(
      [
        {
          cookId: "c1",
          foodPaise: 8000,
          foodDiscountPaise: 0,
          deliveryPaise: 0,
          platformFeePaise: 700,
          qty: 1,
          status: "CANCELLED",
          settlementHold: false,
        },
      ],
      [],
      cooks,
    );
    assert.equal(platform.foodGmvPaise, 0);
    assert.equal(platform.orderCount, 0);
  });

  it("fills cook metadata and COMPLETED settlement bucket", () => {
    const { cooks: rows } = aggregateTurnoverFromRows(
      [
        {
          cookId: "unknown",
          foodPaise: 1000,
          foodDiscountPaise: null,
          deliveryPaise: 0,
          platformFeePaise: 700,
          qty: 1,
          status: "COOKING",
          settlementHold: false,
        },
      ],
      [
        {
          cookId: "c1",
          netPaise: 2000,
          orderCount: 1,
          status: "COMPLETED",
          manualPaidAt: null,
        },
      ],
      cooks,
    );
    const unknown = rows.find((r) => r.cookId === "unknown")!;
    assert.equal(unknown.kitchenName, "unknown");
    assert.equal(unknown.onboardingStatus, "UNKNOWN");
    assert.equal(unknown.slugHandle, "");
    assert.equal(rows.find((r) => r.cookId === "c1")!.transferCompletedPaise, 2000);
  });
});
