import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregateCookUpcomingDays } from "./services/cookOps.js";

describe("aggregateCookUpcomingDays", () => {
  it("groups qty by itemName per service date and meal", () => {
    const days = aggregateCookUpcomingDays([
      {
        serviceDate: "2026-11-25",
        mealType: "LUNCH",
        itemName: "Sambar Rice",
        itemNameTa: "சாம்பார்",
        qty: 2,
      },
      {
        serviceDate: "2026-11-25",
        mealType: "LUNCH",
        itemName: "Sambar Rice",
        qty: 1,
      },
      {
        serviceDate: "2026-11-25",
        mealType: "LUNCH",
        itemName: "Chapathi",
        qty: 2,
      },
      {
        serviceDate: "2026-11-24",
        mealType: "LUNCH",
        itemName: "Idli",
        qty: 4,
      },
    ]);

    assert.equal(days.length, 2);
    assert.equal(days[0].serviceDate, "2026-11-24");
    assert.equal(days[0].totalPlates, 4);
    assert.equal(days[0].lines[0].itemName, "Idli");
    assert.equal(days[0].lines[0].qty, 4);
    assert.equal(days[0].lines[0].orderCount, 1);

    assert.equal(days[1].serviceDate, "2026-11-25");
    assert.equal(days[1].totalPlates, 5);
    const sambar = days[1].lines.find((l) => l.itemName === "Sambar Rice");
    assert.ok(sambar);
    assert.equal(sambar!.qty, 3);
    assert.equal(sambar!.orderCount, 2);
    assert.equal(sambar!.itemNameTa, "சாம்பார்");
  });
});
