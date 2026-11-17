import type { SessionUser } from "../services/auth.js";

/** Fields safe to return when the caller only knows the publicId (pay / confirm pages). */
const PUBLIC_ORDER_KEYS = [
  "id",
  "publicId",
  "checkoutId",
  "status",
  "itemName",
  "itemNameTa",
  "qty",
  "spice",
  "foodPaise",
  "foodDiscountPaise",
  "weekDiscountPercent",
  "deliveryPaise",
  "platformFeePaise",
  "gatewayTxnId",
  "serviceDate",
  "mealType",
  "fulfillmentMode",
  "channel",
  "createdAt",
  "lineTotalPaise",
  "cancellable",
  "cancelRequestable",
] as const;

export type OrderAudience = "public" | "owner" | "staff";

/** Who may see PII on this order (mobiles, full address, pickup reveal). */
export function orderAudience(
  user: SessionUser | null,
  order: {
    customerMobile: string;
    payerMobile?: string | null;
    cookId: string;
  },
  cookSlug: string | null | undefined,
): OrderAudience {
  if (!user) return "public";
  if (user.role === "ADMIN") return "staff";
  if (user.role === "COOK" && cookSlug && user.cookSlug === cookSlug) return "staff";
  if (
    user.role === "CUSTOMER" &&
    (user.mobile === order.customerMobile ||
      (order.payerMobile != null && user.mobile === order.payerMobile))
  ) {
    return "owner";
  }
  return "public";
}

export function redactOrderForAudience<T extends Record<string, unknown>>(
  order: T,
  audience: OrderAudience,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const key of PUBLIC_ORDER_KEYS) {
    if (key in order) base[key] = order[key];
  }
  Object.assign(base, extras);

  if (audience === "public") {
    // Capability URLs must not leak address or mobiles — sign in as owner/staff to see them.
    if ("deliveryTargetAddress" in order) {
      base.hasDeliveryAddress = Boolean(order.deliveryTargetAddress);
    }
    if (extras.pickup) base.pickup = null;
    return base;
  }

  // Owner / staff: include PII + pickup + review fields from extras.
  base.customerMobile = order.customerMobile;
  base.payerMobile = order.payerMobile ?? null;
  if ("deliveryTargetAddress" in order) {
    base.deliveryTargetAddress = order.deliveryTargetAddress;
  }
  return base;
}

/** Concern photo URLs must be our uploaded assets — blocks arbitrary URL injection. */
export function assertSafeConcernPhotoUrl(photoUrl: string | null | undefined): string | null {
  if (photoUrl == null || photoUrl === "") return null;
  const trimmed = photoUrl.trim();
  if (!trimmed.startsWith("/uploads/concern-")) {
    throw new Error("Invalid concern photo");
  }
  if (trimmed.includes("..") || trimmed.includes("//") || trimmed.length > 200) {
    throw new Error("Invalid concern photo");
  }
  return trimmed;
}
