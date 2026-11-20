/**
 * Customer-facing status for a week checkout (multiple day-lines).
 * Never use rows[0].status alone — cancelling day 1 must not hide later PAID days.
 */
export function aggregateCheckoutStatus(statuses: readonly string[]): string {
  if (!statuses.length) return "AWAITING_PAYMENT";
  const set = new Set(statuses);

  if (set.has("CONFIRMING_PAYMENT")) return "CONFIRMING_PAYMENT";
  if (set.has("AWAITING_PAYMENT")) return "AWAITING_PAYMENT";
  if (set.has("PENDING_APPROVAL")) return "PENDING_APPROVAL";
  if (set.has("CANCEL_REQUESTED")) return "CANCEL_REQUESTED";

  // Furthest kitchen/logistics progress among open lines.
  const kitchenProgress = [
    "DELAYED",
    "DISPATCHED",
    "ASSIGNING_RIDER",
    "PACKED",
    "COOKING",
    "PAID",
  ] as const;
  for (const s of kitchenProgress) {
    if (set.has(s)) return s;
  }

  if (set.has("DELIVERED")) return "DELIVERED";
  if (set.has("FAILED")) return "FAILED";
  if (set.has("LOGISTICS_EXCEPTION")) return "LOGISTICS_EXCEPTION";
  if (set.has("RETURNED_TO_KITCHEN")) return "RETURNED_TO_KITCHEN";

  if (statuses.every((s) => s === "REFUNDED")) return "REFUNDED";
  if (statuses.every((s) => s === "CANCELLED")) return "CANCELLED";
  if (set.has("REFUNDED")) return "REFUNDED";
  if (set.has("CANCELLED")) return "CANCELLED";

  return statuses[0]!;
}
