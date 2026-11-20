/** Customer checkout fulfillment modes (order.fulfillment_mode). */
export type FulfillmentMode = "DELIVERY" | "PICKUP" | "CUSTOMER_ARRANGE";

export type CookFulfillmentOffers = {
  /** Cook / family / local auto delivers (SELF Maps). */
  cookDelivery: boolean;
  /** Kitchen pickup (also needs platform pickup_enabled + landmark). */
  pickup: boolean;
  /** Customer arranges their own auto / porter; ₹0 platform delivery. */
  customerArrange: boolean;
};

export function normalizeFulfillmentMode(
  mode: string | null | undefined,
): FulfillmentMode {
  if (mode === "PICKUP") return "PICKUP";
  if (mode === "CUSTOMER_ARRANGE") return "CUSTOMER_ARRANGE";
  return "DELIVERY";
}

export function isZeroDeliveryFulfillment(mode: string | null | undefined): boolean {
  const m = normalizeFulfillmentMode(mode);
  return m === "PICKUP" || m === "CUSTOMER_ARRANGE";
}

/** Delivery and customer-arrange need a saved address; pickup uses landmark after pay. */
export function needsCheckoutAddress(mode: string | null | undefined): boolean {
  const m = normalizeFulfillmentMode(mode);
  return m === "DELIVERY" || m === "CUSTOMER_ARRANGE";
}

export function cookFulfillmentOffersFromRow(cook: {
  offerCookDelivery?: boolean | null;
  pickupEnabled?: boolean | null;
  offerCustomerArrange?: boolean | null;
}): CookFulfillmentOffers {
  return {
    cookDelivery: cook.offerCookDelivery !== false,
    pickup: Boolean(cook.pickupEnabled),
    customerArrange: Boolean(cook.offerCustomerArrange),
  };
}

/** At least one customer-facing path must stay on. */
export function assertFulfillmentOffersValid(offers: CookFulfillmentOffers): void {
  if (!offers.cookDelivery && !offers.pickup && !offers.customerArrange) {
    throw new Error("Turn on at least one: cook delivery, pickup, or customer arranges");
  }
}

export function assertFulfillmentAllowed(
  mode: FulfillmentMode,
  offers: CookFulfillmentOffers,
  opts?: { pickupPlatformAvailable?: boolean },
): void {
  if (mode === "DELIVERY") {
    if (!offers.cookDelivery) {
      throw new Error("This kitchen is not offering cook delivery right now");
    }
    return;
  }
  if (mode === "PICKUP") {
    if (!offers.pickup || opts?.pickupPlatformAvailable === false) {
      throw new Error("This kitchen is not offering pickup right now");
    }
    return;
  }
  if (!offers.customerArrange) {
    throw new Error("This kitchen is not offering customer-arranged delivery right now");
  }
}

/** Pause applies only to the calendar service date stored on the cook. */
export function isIntakePausedForDate(
  intakePausedDate: string | null | undefined,
  serviceDate: string,
): boolean {
  return Boolean(intakePausedDate && intakePausedDate === serviceDate);
}

export function assertIntakeOpen(
  intakePausedDate: string | null | undefined,
  serviceDate: string,
): void {
  if (isIntakePausedForDate(intakePausedDate, serviceDate)) {
    throw new Error("Kitchen paused intake for today — try another kitchen or tomorrow");
  }
}
