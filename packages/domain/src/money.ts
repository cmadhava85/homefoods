/** Customer platform fee (₹7) — once per checkout / payment, not per day. */
export const PLATFORM_FEE_PAISE = 700;

/**
 * Week cart stores one DB row per day under one payment.
 * Put the ₹7 fee on the first day-line only so checkout total is correct.
 */
export function platformFeePaiseForCheckoutLine(lineIndex: number): number {
  return lineIndex === 0 ? PLATFORM_FEE_PAISE : 0;
}

export function orderTotalPaise(input: {
  foodPaise: number;
  deliveryPaise: number;
  platformFeePaise: number;
  qty: number;
  /** Absolute food discount already including qty (week cart). */
  foodDiscountPaise?: number;
}): number {
  const discount = Math.max(0, input.foodDiscountPaise ?? 0);
  const food = Math.max(0, input.foodPaise * input.qty - discount);
  return food + input.deliveryPaise + input.platformFeePaise;
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

export function buildIdempotencyKey(parts: {
  customerMobile: string;
  cookId: string;
  mealType: string;
  serviceDate: string;
  amountPaise: number;
  menuItemId?: number | string;
  spice?: string;
  late?: boolean;
  fulfillmentMode?: "DELIVERY" | "PICKUP";
}): string {
  return [
    parts.late ? "late" : "std",
    parts.customerMobile,
    parts.cookId,
    parts.mealType,
    parts.serviceDate,
    String(parts.amountPaise),
    parts.menuItemId != null ? String(parts.menuItemId) : "",
    parts.spice ?? "",
    parts.fulfillmentMode === "PICKUP" ? "pickup" : "delivery",
  ].join("|");
}
