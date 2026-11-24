import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeWeekDiscount,
  lineFoodDiscountPaise,
  normalizeWeekDiscountRule,
  weekDiscountApplies,
  weekDiscountSurvivesCancel,
  WEEK_DISCOUNT_PERCENT_MAX,
} from "./weekDiscount.js";

describe("week discount", () => {
  it("caps percent and clamps min days", () => {
    assert.deepEqual(normalizeWeekDiscountRule({ percent: 40, minDays: 1 }), {
      percent: WEEK_DISCOUNT_PERCENT_MAX,
      minDays: 2,
    });
    assert.deepEqual(normalizeWeekDiscountRule({ percent: -3, minDays: 99 }), {
      percent: 0,
      minDays: 14,
    });
  });

  it("applies only when day count meets threshold", () => {
    const rule = { percent: 10, minDays: 3 };
    assert.equal(weekDiscountApplies(2, rule), false);
    assert.equal(weekDiscountApplies(3, rule), true);
    assert.equal(weekDiscountApplies(5, { percent: 0, minDays: 3 }), false);
    assert.equal(
      lineFoodDiscountPaise({ foodPaise: 8000, qty: 2, dayCount: 2, rule }),
      0,
    );
    assert.equal(
      lineFoodDiscountPaise({ foodPaise: 8000, qty: 2, dayCount: 3, rule }),
      1600,
    );
  });

  it("describes rule for UI", () => {
    assert.equal(describeWeekDiscount({ percent: 0, minDays: 3 }), null);
    assert.match(describeWeekDiscount({ percent: 10, minDays: 3 })!, /10%.*≥ 3/);
  });

  it("after a cancel, counts remaining calendar days, not meal lines", () => {
    const rule = { percent: 10, minDays: 3 };
    // 2 days × (lunch + dinner) = 4 lines but only 2 days → discount no longer holds.
    assert.equal(
      weekDiscountSurvivesCancel(["2026-11-24", "2026-11-24", "2026-11-25", "2026-11-25"], rule),
      false,
    );
    assert.equal(weekDiscountSurvivesCancel(["2026-11-24", "2026-11-25", "2026-11-26"], rule), true);
    assert.equal(weekDiscountSurvivesCancel([], rule), false);
  });
});
