import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCateringBookable,
  assertCateringCombo,
  assertCateringCutoffHours,
  assertCateringTransition,
  cateringAmounts,
  cateringCutoffAt,
  cateringDuePhase,
  customerCanCancelCatering,
  parseEventTime,
  type CateringBookableInput,
} from "./catering.js";
import { defaultFeatureFlags } from "./featureFlags.js";

// 2026-11-24 10:00 IST
const NOW = new Date("2026-11-24T04:30:00.000Z");

function bookable(over: Partial<CateringBookableInput> = {}): CateringBookableInput {
  return {
    plates: 20,
    minPlates: 20,
    maxPlates: 100,
    eventDate: "2026-11-28",
    eventTime: "12:00",
    cutoffHours: 48,
    bookedPlatesOnDate: 0,
    dailyPlateCap: 100,
    now: NOW,
    ...over,
  };
}

describe("catering", () => {
  it("is off by default", () => {
    assert.equal(defaultFeatureFlags().catering_enabled, false);
  });

  it("splits food 50/50 (advance rounds up) and charges the platform fee once on the advance", () => {
    const a = cateringAmounts({ pricePerPlatePaise: 18_050, plates: 21 });
    assert.equal(a.foodPaise, 379_050);
    assert.equal(a.advancePaise, 189_525 + 700);
    assert.equal(a.balancePaise, 189_525);
    assert.equal(a.advancePaise + a.balancePaise, a.totalPaise);

    const odd = cateringAmounts({ pricePerPlatePaise: 101, plates: 11, platformFeePaise: 0 });
    assert.equal(odd.advancePaise, 556);
    assert.equal(odd.balancePaise, 555);
  });

  it("cut-off is N hours before the IST event start", () => {
    assert.equal(
      cateringCutoffAt("2026-11-28", "12:00", 48).toISOString(),
      "2026-11-26T06:30:00.000Z",
    );
  });

  it("validates event time format and range", () => {
    assert.deepEqual(parseEventTime("07:30"), { hour: 7, minute: 30 });
    assert.throws(() => parseEventTime("7:30"), /HH:MM/);
    assert.throws(() => parseEventTime("23:00"), /between/);
    assert.throws(() => parseEventTime("05:59"), /between/);
  });

  it("enforces MOQ, max plates, notice, horizon and daily capacity", () => {
    assert.doesNotThrow(() => assertCateringBookable(bookable()));
    assert.throws(() => assertCateringBookable(bookable({ plates: 19 })), /Minimum order is 20/);
    assert.throws(() => assertCateringBookable(bookable({ plates: 101 })), /up to 100/);
    // 2026-11-26 10:00 event → cut-off 2026-11-24 10:00 = now
    assert.throws(
      () => assertCateringBookable(bookable({ eventDate: "2026-11-26", eventTime: "10:00" })),
      /48 hours notice/,
    );
    assert.doesNotThrow(() =>
      assertCateringBookable(bookable({ eventDate: "2026-11-26", eventTime: "10:01" })),
    );
    assert.throws(() => assertCateringBookable(bookable({ eventDate: "2027-01-24" })), /60 days/);
    assert.throws(
      () => assertCateringBookable(bookable({ bookedPlatesOnDate: 90 })),
      /only 10 more party plates/,
    );
    assert.throws(
      () => assertCateringBookable(bookable({ bookedPlatesOnDate: 100 })),
      /fully booked/,
    );
  });

  it("validates combos and cut-off hours", () => {
    const ok = { name: "Seemantham Feast", pricePerPlatePaise: 25_000, minPlates: 20, maxPlates: 80 };
    assert.doesNotThrow(() => assertCateringCombo(ok));
    assert.throws(() => assertCateringCombo({ ...ok, name: " " }), /name/);
    assert.throws(() => assertCateringCombo({ ...ok, minPlates: 9 }), /at least 10/);
    assert.throws(() => assertCateringCombo({ ...ok, maxPlates: 19 }), /Maximum plates/);
    assert.throws(() => assertCateringCombo({ ...ok, maxPlates: 151 }), /Maximum plates/);
    assert.doesNotThrow(() => assertCateringCutoffHours(72));
    assert.throws(() => assertCateringCutoffHours(47), /48–72/);
    assert.throws(() => assertCateringCutoffHours(73), /48–72/);
  });

  it("follows advance → balance → completed, cancel from any open state", () => {
    assert.doesNotThrow(() => assertCateringTransition("AWAITING_ADVANCE", "ADVANCE_PAID"));
    assert.doesNotThrow(() => assertCateringTransition("ADVANCE_PAID", "PAID"));
    assert.doesNotThrow(() => assertCateringTransition("PAID", "COMPLETED"));
    assert.doesNotThrow(() => assertCateringTransition("ADVANCE_PAID", "CANCELLED"));
    assert.throws(() => assertCateringTransition("AWAITING_ADVANCE", "PAID"), /cannot move/);
    assert.throws(() => assertCateringTransition("COMPLETED", "CANCELLED"), /cannot move/);
    assert.throws(() => assertCateringTransition("CANCELLED", "ADVANCE_PAID"), /cannot move/);
    assert.equal(cateringDuePhase("AWAITING_ADVANCE"), "ADVANCE");
    assert.equal(cateringDuePhase("ADVANCE_PAID"), "BALANCE");
    assert.equal(cateringDuePhase("PAID"), null);
  });

  it("customers self-cancel before the advance anytime, after it only before cut-off", () => {
    const cutoff = new Date(NOW.getTime() + 1000);
    assert.equal(customerCanCancelCatering("AWAITING_ADVANCE", new Date(0), NOW), true);
    assert.equal(customerCanCancelCatering("ADVANCE_PAID", cutoff, NOW), true);
    assert.equal(customerCanCancelCatering("PAID", new Date(NOW.getTime()), NOW), false);
    assert.equal(customerCanCancelCatering("COMPLETED", cutoff, NOW), false);
  });
});
