import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertValidCutoff,
  assertValidDeliveryWindow,
  cutoffConfigForCook,
  defaultCutoffConfig,
  defaultDeliveryWindow,
  defaultMealSchedule,
  deliveryWindowForCook,
  formatCutoffLabel,
  formatDeliveryWindowLabel,
  isAtOrPastCutoff,
  isBeforeCutoff,
  mealLabel,
  MEAL_PERIODS,
  resolveMealSchedule,
  serviceDateISO,
} from "./cutoff.js";

describe("cutoff", () => {
  it("exposes all meal periods", () => {
    assert.deepEqual(MEAL_PERIODS, ["BREAKFAST", "LUNCH", "DINNER"]);
  });

  it("formats and validates cook cut-off", () => {
    assert.equal(formatCutoffLabel({ hour: 8, minute: 0 }), "08:00");
    assert.equal(formatCutoffLabel({ hour: 9, minute: 30 }), "09:30");
    assert.equal(formatCutoffLabel({ hour: 0, minute: 0 }), "00:00");
    assert.throws(() => assertValidCutoff(-1, 0), /0–23|0-23/);
    assert.throws(() => assertValidCutoff(24, 0), /0–23|0-23/);
    assert.throws(() => assertValidCutoff(8, 60), /0–59|0-59/);
    assert.throws(() => assertValidCutoff(8, -1), /0–59|0-59/);
    assertValidCutoff(0, 0);
    assertValidCutoff(23, 59);
  });

  it("falls back to platform default for cook without preference", () => {
    const prevH = process.env.LUNCH_CUTOFF_HOUR;
    const prevM = process.env.LUNCH_CUTOFF_MINUTE;
    process.env.LUNCH_CUTOFF_HOUR = "7";
    process.env.LUNCH_CUTOFF_MINUTE = "15";
    try {
      assert.deepEqual(defaultCutoffConfig(), { hour: 7, minute: 15 });
      assert.deepEqual(cutoffConfigForCook({}), { hour: 7, minute: 15 });
    } finally {
      process.env.LUNCH_CUTOFF_HOUR = prevH;
      process.env.LUNCH_CUTOFF_MINUTE = prevM;
    }
  });

  it("uses cook-desired time over platform default", () => {
    const cfg = cutoffConfigForCook({ lunchCutoffHour: 10, lunchCutoffMinute: 45 });
    assert.deepEqual(cfg, { hour: 10, minute: 45 });
  });

  it("isBeforeCutoff / isAtOrPastCutoff agree for all meals", () => {
    const cfg = { hour: 8, minute: 0 };
    const date = "2026-11-04";
    const before = new Date(2026, 10, 4, 7, 59);
    const after = new Date(2026, 10, 4, 8, 0);
    assert.equal(isBeforeCutoff("LUNCH", before, date, cfg), true);
    assert.equal(isAtOrPastCutoff("LUNCH", before, date, cfg), false);
    assert.equal(isBeforeCutoff("BREAKFAST", after, date, cfg), false);
    assert.equal(isAtOrPastCutoff("DINNER", after, date, cfg), true);
  });

  it("default meal schedules differ by period", () => {
    const breakfast = defaultMealSchedule("BREAKFAST");
    assert.equal(breakfast.mealType, "BREAKFAST");
    assert.equal(breakfast.enabled, false);
    assert.deepEqual(breakfast.cutoff, { hour: 6, minute: 30 });
    assert.deepEqual(breakfast.deliveryWindow, {
      startHour: 7,
      startMinute: 30,
      endHour: 8,
      endMinute: 30,
    });

    const dinner = defaultMealSchedule("DINNER");
    assert.equal(dinner.mealType, "DINNER");
    assert.equal(dinner.enabled, false);
    assert.deepEqual(dinner.cutoff, { hour: 16, minute: 0 });
    assert.deepEqual(dinner.deliveryWindow, {
      startHour: 19,
      startMinute: 0,
      endHour: 20,
      endMinute: 0,
    });

    const lunch = defaultMealSchedule("LUNCH");
    assert.equal(lunch.mealType, "LUNCH");
    assert.equal(lunch.enabled, true);
    assert.equal(typeof lunch.cutoff.hour, "number");
    assert.equal(typeof lunch.deliveryWindow.startHour, "number");
    assert.deepEqual(defaultDeliveryWindow(), lunch.deliveryWindow);
  });

  it("honours lunch delivery env overrides", () => {
    const keys = [
      "LUNCH_DELIVERY_START_HOUR",
      "LUNCH_DELIVERY_START_MINUTE",
      "LUNCH_DELIVERY_END_HOUR",
      "LUNCH_DELIVERY_END_MINUTE",
    ] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.LUNCH_DELIVERY_START_HOUR = "11";
    process.env.LUNCH_DELIVERY_START_MINUTE = "30";
    process.env.LUNCH_DELIVERY_END_HOUR = "12";
    process.env.LUNCH_DELIVERY_END_MINUTE = "45";
    try {
      assert.deepEqual(defaultMealSchedule("LUNCH").deliveryWindow, {
        startHour: 11,
        startMinute: 30,
        endHour: 12,
        endMinute: 45,
      });
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });

  it("resolveMealSchedule prefers row over defaults", () => {
    const s = resolveMealSchedule("DINNER", [
      {
        mealType: "DINNER",
        enabled: true,
        cutoffHour: 17,
        cutoffMinute: 15,
        deliveryStartHour: 19,
        deliveryStartMinute: 30,
        deliveryEndHour: 20,
        deliveryEndMinute: 30,
      },
    ]);
    assert.equal(s.enabled, true);
    assert.equal(s.cutoff.hour, 17);
    assert.equal(s.deliveryWindow.startMinute, 30);
  });

  it("resolveMealSchedule falls back and forces LUNCH enabled from row", () => {
    assert.equal(resolveMealSchedule("BREAKFAST", []).mealType, "BREAKFAST");
    assert.equal(resolveMealSchedule("BREAKFAST", []).enabled, false);

    const lunchLegacy = resolveMealSchedule("LUNCH", undefined, {
      lunchCutoffHour: 9,
      lunchCutoffMinute: 15,
      deliveryWindowStartHour: 12,
      deliveryWindowStartMinute: 10,
      deliveryWindowEndHour: 13,
      deliveryWindowEndMinute: 20,
    });
    assert.equal(lunchLegacy.enabled, true);
    assert.deepEqual(lunchLegacy.cutoff, { hour: 9, minute: 15 });
    assert.deepEqual(lunchLegacy.deliveryWindow, {
      startHour: 12,
      startMinute: 10,
      endHour: 13,
      endMinute: 20,
    });

    const lunchRow = resolveMealSchedule("LUNCH", [
      {
        mealType: "LUNCH",
        enabled: false,
        cutoffHour: 8,
        cutoffMinute: 0,
        deliveryStartHour: 12,
        deliveryStartMinute: 0,
        deliveryEndHour: 13,
        deliveryEndMinute: 0,
      },
    ]);
    assert.equal(lunchRow.enabled, true);
    assert.equal(lunchRow.mealType, "LUNCH");
  });

  it("serviceDateISO is YYYY-MM-DD", () => {
    assert.match(serviceDateISO(new Date(2026, 10, 4)), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("labels meals and delivery windows", () => {
    assert.equal(mealLabel("BREAKFAST"), "Breakfast");
    assert.equal(mealLabel("LUNCH"), "Lunch");
    assert.equal(mealLabel("DINNER"), "Dinner");
    assert.equal(
      formatDeliveryWindowLabel({
        startHour: 12,
        startMinute: 0,
        endHour: 13,
        endMinute: 30,
      }),
      "12:00–13:30",
    );
    assertValidDeliveryWindow({
      startHour: 12,
      startMinute: 0,
      endHour: 13,
      endMinute: 0,
    });
    assert.throws(
      () =>
        assertValidDeliveryWindow({
          startHour: 13,
          startMinute: 0,
          endHour: 12,
          endMinute: 0,
        }),
      /after start/,
    );
    assert.deepEqual(
      deliveryWindowForCook({
        deliveryWindowStartHour: 11,
        deliveryWindowStartMinute: 15,
        deliveryWindowEndHour: 12,
        deliveryWindowEndMinute: 45,
      }),
      { startHour: 11, startMinute: 15, endHour: 12, endMinute: 45 },
    );
  });
});
