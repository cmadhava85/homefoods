import { describe, it } from "node:test";
import assert from "node:assert/strict";

/** Mirrors FIFO apply used in applyPendingClawbacksToSettlement. */
function planApply(pendingAmounts: number[], availablePaise: number) {
  let left = Math.max(0, availablePaise);
  let applied = 0;
  const remaining: number[] = [];
  for (const owe of pendingAmounts) {
    if (left <= 0) {
      remaining.push(owe);
      continue;
    }
    const take = Math.min(Math.max(0, owe), left);
    applied += take;
    left -= take;
    if (owe - take > 0) remaining.push(owe - take);
  }
  return { applied, remaining, net: Math.max(0, availablePaise - applied) };
}

describe("cook clawback FIFO plan", () => {
  it("nets full recovery when gross covers pending", () => {
    const r = planApply([5000, 2000], 10000);
    assert.equal(r.applied, 7000);
    assert.deepEqual(r.remaining, []);
    assert.equal(r.net, 3000);
  });

  it("partially applies and keeps remainder pending", () => {
    const r = planApply([8000], 5000);
    assert.equal(r.applied, 5000);
    assert.deepEqual(r.remaining, [3000]);
    assert.equal(r.net, 0);
  });

  it("applies nothing when no gross", () => {
    const r = planApply([4000], 0);
    assert.equal(r.applied, 0);
    assert.deepEqual(r.remaining, [4000]);
    assert.equal(r.net, 0);
  });
});
