/**
 * Domain unit tests live in packages/domain/src/*.test.ts.
 * This file kept so historical suite name remains discoverable — re-exports coverage via import.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canTransition, isTerminal } from "@localmeals/domain";

describe("domain package wired into api", () => {
  it("exports state machine used by services", () => {
    assert.equal(canTransition("PAID", "COOKING"), true);
    assert.equal(isTerminal("DELIVERED"), true);
  });
});
