/**
 * Default customer platform fee (₹7) — once per checkout / payment, not per day.
 * The live value is admin-editable (Admin → Pricing); this is the seed / fallback.
 */
export const PLATFORM_FEE_PAISE = 700;
/** Guard rail for the admin-editable platform fee (₹50). */
export const MAX_PLATFORM_FEE_PAISE = 5_000;

/** Default cook commission: 5% of food (basis points). Admin-editable, per-cook override allowed. */
export const DEFAULT_COOK_COMMISSION_BPS = 500;
/** Guard rail for global and per-cook commission: 10% of food. */
export const MAX_COOK_COMMISSION_BPS = 1_000;

/**
 * Week cart stores one DB row per day under one payment.
 * Put the fee on the first day-line only so checkout total is correct.
 */
export function platformFeePaiseForCheckoutLine(
  lineIndex: number,
  feePaise: number = PLATFORM_FEE_PAISE,
): number {
  return lineIndex === 0 ? feePaise : 0;
}

/** Cook override wins over the platform default; both are clamped to the guard rail. */
export function effectiveCommissionBps(platformBps: number, cookOverrideBps?: number | null): number {
  const bps = cookOverrideBps ?? platformBps;
  return Math.min(MAX_COOK_COMMISSION_BPS, Math.max(0, Math.trunc(bps)));
}

/** Platform share of a line's food net. Rounded down so the cook never loses a fraction of a paisa. */
export function commissionPaise(foodNetPaise: number, bps: number): number {
  if (foodNetPaise <= 0 || bps <= 0) return 0;
  return Math.floor((foodNetPaise * bps) / 10_000);
}

export function orderTotalPaise(input: {
  foodPaise: number;
  deliveryPaise: number;
  platformFeePaise: number;
  qty: number;
  /** Absolute food discount already including qty (week cart). */
  foodDiscountPaise?: number;
  convenienceFeePaise?: number;
}): number {
  const discount = Math.max(0, input.foodDiscountPaise ?? 0);
  const food = Math.max(0, input.foodPaise * input.qty - discount);
  return food + input.deliveryPaise + input.platformFeePaise + (input.convenienceFeePaise ?? 0);
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

/** Snapshot amounts stored on an order line. */
export type OrderLineAmounts = {
  foodPaise: number;
  qty: number;
  /** Absolute week discount for the line (already includes qty). */
  foodDiscountPaise?: number | null;
  deliveryPaise: number;
  platformFeePaise: number;
  convenienceFeePaise?: number | null;
  /** Wallet credit used on this line (part of lineTotal, not charged by the gateway). */
  creditAppliedPaise?: number | null;
};

/** Food after week discount — what the cook is settled on and what FOOD_ONLY refunds. */
export function lineFoodNetPaise(o: Pick<OrderLineAmounts, "foodPaise" | "qty" | "foodDiscountPaise">): number {
  return Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0));
}

/** What the customer paid for a stored line (food net + delivery + platform fee + convenience fee). */
export function lineTotalPaise(o: OrderLineAmounts): number {
  return lineFoodNetPaise(o) + o.deliveryPaise + o.platformFeePaise + (o.convenienceFeePaise ?? 0);
}

/** The part of a line paid through the gateway (total minus wallet credit). */
export function lineGatewayPaise(o: OrderLineAmounts): number {
  return Math.max(0, lineTotalPaise(o) - (o.creditAppliedPaise ?? 0));
}

export type PaymentMethod = "LINK" | "UPI_QR" | "CREDIT";

/**
 * Razorpay cost incl. 18% GST, in basis points: payment links 2% → 2.36%, UPI QR 0.99% → 1.17%.
 * (razorpay.com/pricing, May 2026.) Override with CONVENIENCE_FEE_BPS_LINK / _UPI_QR on the API.
 */
export const GATEWAY_FEE_BPS: Record<Exclude<PaymentMethod, "CREDIT">, number> = {
  LINK: 236,
  UPI_QR: 117,
};

/**
 * Fee that makes the merchant net exactly `gatewayBasePaise` after the gateway deducts `bps` from the
 * grossed-up charge: fee = ceil(base·bps / (10000 − bps)). 0 when nothing goes through the gateway.
 */
export function convenienceFeePaise(gatewayBasePaise: number, bps: number): number {
  if (gatewayBasePaise <= 0 || bps <= 0) return 0;
  return Math.ceil((gatewayBasePaise * bps) / (10_000 - bps));
}

/** Spend available credit across lines in order (earliest line first). */
export function allocateCredit(lineBasesPaise: number[], availablePaise: number): number[] {
  let left = Math.max(0, availablePaise);
  return lineBasesPaise.map((base) => {
    const use = Math.min(left, Math.max(0, base));
    left -= use;
    return use;
  });
}

/** Per-line credit + fee for a checkout. Fee is charged only on the gateway part of each line. */
export function priceCheckoutLines(
  lineBasesPaise: number[],
  opts: { creditAvailablePaise: number; feeBps: number },
): Array<{ creditAppliedPaise: number; convenienceFeePaise: number; gatewayPaise: number }> {
  const credit = allocateCredit(lineBasesPaise, opts.creditAvailablePaise);
  return lineBasesPaise.map((base, i) => {
    const gatewayBase = base - credit[i];
    const fee = convenienceFeePaise(gatewayBase, opts.feeBps);
    return { creditAppliedPaise: credit[i], convenienceFeePaise: fee, gatewayPaise: gatewayBase + fee };
  });
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
  fulfillmentMode?: "DELIVERY" | "PICKUP" | "CUSTOMER_ARRANGE";
}): string {
  const fulfill =
    parts.fulfillmentMode === "PICKUP"
      ? "pickup"
      : parts.fulfillmentMode === "CUSTOMER_ARRANGE"
        ? "arrange"
        : "delivery";
  return [
    parts.late ? "late" : "std",
    parts.customerMobile,
    parts.cookId,
    parts.mealType,
    parts.serviceDate,
    String(parts.amountPaise),
    parts.menuItemId != null ? String(parts.menuItemId) : "",
    parts.spice ?? "",
    fulfill,
  ].join("|");
}
