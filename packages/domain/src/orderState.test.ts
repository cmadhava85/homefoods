import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertTransition,
  canTransition,
  isTerminal,
  type OrderState,
} from "./orderState.js";

const MVP_HAPPY: OrderState[] = [
  "AWAITING_PAYMENT",
  "PAID",
  "COOKING",
  "PACKED",
  "DISPATCHED",
  "DELIVERED",
];

describe("order state machine", () => {
  it("allows MVP happy-path chain", () => {
    for (let i = 0; i < MVP_HAPPY.length - 1; i++) {
      assert.equal(
        canTransition(MVP_HAPPY[i], MVP_HAPPY[i + 1]),
        true,
        `${MVP_HAPPY[i]} -> ${MVP_HAPPY[i + 1]}`,
      );
    }
  });

  it("allows refunds from paid through dispatched", () => {
    for (const from of ["PAID", "COOKING", "PACKED", "DISPATCHED"] as OrderState[]) {
      assert.equal(canTransition(from, "REFUNDED"), true);
    }
  });

  it("allows pickup packed → delivered without dispatch", () => {
    assert.equal(canTransition("PACKED", "DELIVERED"), true);
  });

  it("covers draft, late, confirming, and logistics edges", () => {
    assert.equal(canTransition("DRAFT", "PENDING_APPROVAL"), true);
    assert.equal(canTransition("DRAFT", "AWAITING_PAYMENT"), true);
    assert.equal(canTransition("DRAFT", "CANCELLED"), true);
    assert.equal(canTransition("PENDING_APPROVAL", "AWAITING_PAYMENT"), true);
    assert.equal(canTransition("PENDING_APPROVAL", "CANCELLED"), true);
    assert.equal(canTransition("AWAITING_PAYMENT", "CONFIRMING_PAYMENT"), true);
    assert.equal(canTransition("AWAITING_PAYMENT", "FAILED"), true);
    assert.equal(canTransition("CONFIRMING_PAYMENT", "PAID"), true);
    assert.equal(canTransition("CONFIRMING_PAYMENT", "FAILED"), true);
    assert.equal(canTransition("PACKED", "ASSIGNING_RIDER"), true);
    assert.equal(canTransition("ASSIGNING_RIDER", "DISPATCHED"), true);
    assert.equal(canTransition("ASSIGNING_RIDER", "LOGISTICS_EXCEPTION"), true);
    assert.equal(canTransition("DISPATCHED", "DELAYED"), true);
    assert.equal(canTransition("DISPATCHED", "RETURNED_TO_KITCHEN"), true);
    assert.equal(canTransition("DISPATCHED", "LOGISTICS_EXCEPTION"), true);
    assert.equal(canTransition("DELAYED", "DELIVERED"), true);
    assert.equal(canTransition("DELAYED", "RETURNED_TO_KITCHEN"), true);
    assert.equal(canTransition("DELAYED", "LOGISTICS_EXCEPTION"), true);
    assert.equal(canTransition("DELAYED", "REFUNDED"), true);
    assert.equal(canTransition("RETURNED_TO_KITCHEN", "REFUNDED"), true);
    assert.equal(canTransition("RETURNED_TO_KITCHEN", "DISPATCHED"), true);
    assert.equal(canTransition("LOGISTICS_EXCEPTION", "REFUNDED"), true);
    assert.equal(canTransition("LOGISTICS_EXCEPTION", "DELIVERED"), true);
    assert.equal(canTransition("FAILED", "CANCELLED"), true);
  });

  it("blocks reverse and terminal mutations", () => {
    assert.equal(canTransition("DELIVERED", "PAID"), false);
    assert.equal(canTransition("REFUNDED", "PAID"), false);
    assert.equal(canTransition("CANCELLED", "PAID"), false);
    assert.equal(canTransition("FAILED", "PAID"), false);
    assert.throws(() => assertTransition("DELIVERED", "COOKING"), /can’t move|can't move/i);
  });

  it("marks terminal states", () => {
    assert.equal(isTerminal("DELIVERED"), true);
    assert.equal(isTerminal("REFUNDED"), true);
    assert.equal(isTerminal("CANCELLED"), true);
    assert.equal(isTerminal("FAILED"), false); // may expire → CANCELLED
    assert.equal(isTerminal("PAID"), false);
  });

  it("allows cancel before cooking", () => {
    assert.equal(canTransition("AWAITING_PAYMENT", "CANCELLED"), true);
    assert.equal(canTransition("PAID", "CANCELLED"), true);
    assert.equal(canTransition("COOKING", "CANCELLED"), false);
  });

  it("allows post–cut-off cancel request ↔ cook decide", () => {
    assert.equal(canTransition("PAID", "CANCEL_REQUESTED"), true);
    assert.equal(canTransition("CANCEL_REQUESTED", "PAID"), true);
    assert.equal(canTransition("CANCEL_REQUESTED", "REFUNDED"), true);
    assert.equal(canTransition("CANCEL_REQUESTED", "CANCELLED"), true);
    assert.equal(canTransition("COOKING", "CANCEL_REQUESTED"), false);
  });
});
