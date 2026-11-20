/**
 * Client-safe fulfillment helpers.
 * Kept local (not imported from @localmeals/domain at runtime) because Next/webpack
 * ESM re-exports of domain dist can leave normalizeFulfillmentMode undefined on
 * the kitchen page client/SSR graph.
 */

export type FulfillmentMode = "DELIVERY" | "PICKUP" | "CUSTOMER_ARRANGE";

export type FulfillmentOffersView = {
  cookDelivery?: boolean;
  pickup?: boolean;
  customerArrange?: boolean;
};

export function normalizeFulfillmentMode(
  mode: string | null | undefined,
): FulfillmentMode {
  if (mode === "PICKUP") return "PICKUP";
  if (mode === "CUSTOMER_ARRANGE") return "CUSTOMER_ARRANGE";
  return "DELIVERY";
}

/** Delivery and customer-arrange need a saved address; pickup uses landmark after pay. */
export function needsCheckoutAddress(mode: string | null | undefined): boolean {
  const m = normalizeFulfillmentMode(mode);
  return m === "DELIVERY" || m === "CUSTOMER_ARRANGE";
}

export function resolveEffectiveFulfillment(
  selected: FulfillmentMode | string,
  offers: FulfillmentOffersView | null | undefined,
  pickupAvailable: boolean,
): FulfillmentMode {
  const cookDeliveryOk = offers?.cookDelivery !== false;
  const pickupOk = Boolean(pickupAvailable || offers?.pickup);
  const arrangeOk = Boolean(offers?.customerArrange);
  const want = normalizeFulfillmentMode(selected);

  if (want === "PICKUP" && pickupOk) return "PICKUP";
  if (want === "CUSTOMER_ARRANGE" && arrangeOk) return "CUSTOMER_ARRANGE";
  if (want === "DELIVERY" && cookDeliveryOk) return "DELIVERY";
  if (cookDeliveryOk) return "DELIVERY";
  if (pickupOk) return "PICKUP";
  if (arrangeOk) return "CUSTOMER_ARRANGE";
  return "DELIVERY";
}

export function showFulfillmentChooser(
  offers: FulfillmentOffersView | null | undefined,
  pickupAvailable: boolean,
) {
  const cookDeliveryOk = offers?.cookDelivery !== false;
  const pickupOk = Boolean(pickupAvailable || offers?.pickup);
  const arrangeOk = Boolean(offers?.customerArrange);
  return [cookDeliveryOk, pickupOk, arrangeOk].filter(Boolean).length > 1;
}
