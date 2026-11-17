import { mealLabel, type MealPeriod } from "./cutoff.js";

export type OrderPaidNotifyPayload = {
  publicId?: unknown;
  checkoutId?: unknown;
  serviceDate?: unknown;
  mealType?: unknown;
  itemName?: unknown;
  qty?: unknown;
  spice?: unknown;
  deliveryWindow?: unknown;
  deliveryTargetAddress?: unknown;
  customerMobile?: unknown;
  cookSlug?: unknown;
  /** Days in this checkout (1 = single-day). */
  checkoutDayCount?: unknown;
  /** 1-based index by serviceDate within the checkout. */
  checkoutDayOrdinal?: unknown;
};

function str(v: unknown) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function asMeal(v: unknown): MealPeriod {
  const m = str(v).toUpperCase();
  if (m === "BREAKFAST" || m === "DINNER") return m;
  return "LUNCH";
}

function dayCount(payload: OrderPaidNotifyPayload): number {
  const n = Number(payload.checkoutDayCount);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function dayOrdinal(payload: OrderPaidNotifyPayload): number {
  const n = Number(payload.checkoutDayOrdinal);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

/** Cook WhatsApp body when a day-line becomes PAID (incl. week-cart context). */
export function formatOrderPaidCookWa(payload: OrderPaidNotifyPayload): string {
  const publicId = str(payload.publicId);
  const serviceDate = str(payload.serviceDate);
  const checkoutId = str(payload.checkoutId);
  const count = dayCount(payload);
  const ordinal = dayOrdinal(payload);
  const week = count > 1;
  const meal = mealLabel(asMeal(payload.mealType));

  return [
    week
      ? `🆕 New PAID ${meal} · day ${ordinal} of ${count}`
      : `🆕 New PAID ${meal} order`,
    serviceDate ? `For ${serviceDate}` : null,
    week && checkoutId ? `Week cart ${checkoutId}` : null,
    `${publicId} · ${payload.qty ?? 1}× ${str(payload.itemName) || "plate"}`,
    payload.spice ? `Spice: ${payload.spice}` : null,
    payload.deliveryWindow ? `ETA window: ${payload.deliveryWindow}` : null,
    `📍 ${str(payload.deliveryTargetAddress) || "address TBD"}`,
    `Customer: ${str(payload.customerMobile)}`,
    "",
    week
      ? "This plate is for that day only — Status shows today’s queue. Reply Status · Cooking · Packed."
      : "Reply Status · Cooking · Packed on WhatsApp.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Customer WhatsApp body for a paid day-line. */
export function formatOrderPaidCustomerWa(payload: OrderPaidNotifyPayload): string {
  const publicId = str(payload.publicId);
  const serviceDate = str(payload.serviceDate);
  const checkoutId = str(payload.checkoutId);
  const count = dayCount(payload);
  const ordinal = dayOrdinal(payload);
  const week = count > 1;

  return [
    `✅ Payment received · ${publicId}`,
    serviceDate ? `For ${serviceDate}` : null,
    week
      ? `Week cart${checkoutId ? ` ${checkoutId}` : ""} · day ${ordinal} of ${count}`
      : null,
    `${payload.qty ?? 1}× ${str(payload.itemName) || "plate"}`,
    payload.deliveryWindow ? `ETA ${str(payload.deliveryWindow)}` : null,
    str(payload.cookSlug) ? `Kitchen: ${str(payload.cookSlug)}` : null,
    "",
    week
      ? "Each day cooks separately — we’ll ping when that day’s plate is on the way. Reply Orders anytime."
      : "We’ll ping you when it’s on the way / delivered. Reply Orders anytime.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Cook desk WA feed preview line. */
export function formatOrderPaidFeedPreview(payload: OrderPaidNotifyPayload): string {
  const publicId = str(payload.publicId);
  const serviceDate = str(payload.serviceDate);
  const count = dayCount(payload);
  const ordinal = dayOrdinal(payload);
  const plate = `${payload.qty ?? 1}× ${str(payload.itemName) || "plate"}`;
  const dateBit = serviceDate ? `${serviceDate} · ` : "";
  const weekBit = count > 1 ? ` · week day ${ordinal}/${count}` : "";
  return `New PAID ${dateBit}${publicId} · ${plate}${weekBit}`.trim();
}
