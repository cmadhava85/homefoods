export const ORDER_STATES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "AWAITING_PAYMENT",
  "CONFIRMING_PAYMENT",
  "PAID",
  /** Customer asked to cancel after cut-off — cook Accept → refund, Decline → back to PAID */
  "CANCEL_REQUESTED",
  "COOKING",
  "PACKED",
  /** Partner logistics: waiting for rider (SELF skips this). */
  "ASSIGNING_RIDER",
  "DISPATCHED",
  "DELAYED",
  "DELIVERED",
  "RETURNED_TO_KITCHEN",
  "LOGISTICS_EXCEPTION",
  "CANCELLED",
  "REFUNDED",
  "FAILED",
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const TRANSITIONS: Record<OrderState, OrderState[]> = {
  DRAFT: ["PENDING_APPROVAL", "AWAITING_PAYMENT", "CANCELLED"],
  PENDING_APPROVAL: ["AWAITING_PAYMENT", "CANCELLED"],
  AWAITING_PAYMENT: ["CONFIRMING_PAYMENT", "PAID", "FAILED", "CANCELLED"],
  CONFIRMING_PAYMENT: ["PAID", "FAILED"],
  PAID: ["COOKING", "CANCEL_REQUESTED", "CANCELLED", "REFUNDED"],
  /** Decline restores PAID or COOKING depending on whether cut-off already locked. */
  CANCEL_REQUESTED: ["PAID", "COOKING", "CANCELLED", "REFUNDED"],
  /** Post–cut-off lock moves PAID→COOKING; customer cancel-ask must still be reachable. */
  COOKING: ["PACKED", "REFUNDED", "CANCEL_REQUESTED"],
  /** DISPATCHED = out for delivery; DELIVERED from PACKED = pickup collected. */
  PACKED: ["ASSIGNING_RIDER", "DISPATCHED", "DELIVERED", "REFUNDED"],
  ASSIGNING_RIDER: ["DISPATCHED", "LOGISTICS_EXCEPTION", "REFUNDED"],
  DISPATCHED: ["DELIVERED", "DELAYED", "RETURNED_TO_KITCHEN", "LOGISTICS_EXCEPTION", "REFUNDED"],
  DELAYED: ["DELIVERED", "RETURNED_TO_KITCHEN", "LOGISTICS_EXCEPTION", "REFUNDED"],
  DELIVERED: [],
  RETURNED_TO_KITCHEN: ["REFUNDED", "DISPATCHED"],
  LOGISTICS_EXCEPTION: ["REFUNDED", "DELIVERED"],
  CANCELLED: [],
  REFUNDED: [],
  /** Expired unpaid / failed pay after service date → drop from Open list */
  FAILED: ["CANCELLED"],
};

export function canTransition(from: OrderState, to: OrderState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!canTransition(from, to)) {
    throw new Error("That order can’t move to that status right now");
  }
}

export function isTerminal(state: OrderState): boolean {
  return TRANSITIONS[state].length === 0;
}
