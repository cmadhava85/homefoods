import { isZeroDeliveryFulfillment } from "./fulfillment.js";

/** Free cook-delivery band when `delivery_distance_limits_enabled` is on. */
export const FREE_SELF_DELIVERY_KM = 3;
/** Max cook-delivery distance when distance limits are on (beyond = block). */
export const MAX_SELF_DELIVERY_KM = 5;

export type LatLng = { lat: number; lng: number };

export type SelfDeliveryBand = "FREE" | "PAID" | "TOO_FAR" | "MISSING_COORDS";

export function parseCoord(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

export function parseLatLng(
  lat: string | number | null | undefined,
  lng: string | number | null | undefined,
): LatLng | null {
  const la = parseCoord(lat);
  const ln = parseCoord(lng);
  if (la == null || ln == null) return null;
  if (la < -90 || la > 90 || ln < -180 || ln > 180) return null;
  return { lat: la, lng: ln };
}

/**
 * Approximate pin centres for launch pins (when address has no GPS).
 * Client GPS is accepted only when it stays near a known pin centroid.
 */
export const PIN_CENTROIDS: Record<string, LatLng> = {
  "600119": { lat: 12.901, lng: 80.227 }, // Sholinganallur / OMR cluster
};

/** Reject client GPS farther than this from the PIN centroid (billing / limits). */
export const MAX_CLIENT_GPS_PIN_DRIFT_KM = 8;

export function pinCentroid(pinCode: string | null | undefined): LatLng | null {
  if (!pinCode) return null;
  const pin = String(pinCode).replace(/\D/g, "").slice(0, 6);
  return PIN_CENTROIDS[pin] ?? null;
}

/**
 * Trusted coords for delivery distance / storage.
 * Client GPS is used only when a known PIN centroid exists and GPS is near it;
 * otherwise the centroid. Unknown PINs never trust client lat/lng alone (spoof bypass).
 */
export function resolveAddressLatLng(input: {
  lat?: string | number | null;
  lng?: string | number | null;
  pinCode?: string | null;
}): LatLng | null {
  const centroid = pinCentroid(input.pinCode);
  if (!centroid) return null;
  const explicit = parseLatLng(input.lat, input.lng);
  if (explicit && haversineKm(explicit, centroid) <= MAX_CLIENT_GPS_PIN_DRIFT_KM) {
    return explicit;
  }
  return centroid;
}

/** Great-circle distance in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function selfDeliveryBand(distanceKm: number | null): SelfDeliveryBand {
  if (distanceKm == null || !Number.isFinite(distanceKm)) return "MISSING_COORDS";
  if (distanceKm <= FREE_SELF_DELIVERY_KM) return "FREE";
  if (distanceKm <= MAX_SELF_DELIVERY_KM) return "PAID";
  return "TOO_FAR";
}

export const DELIVERY_DISTANCE_MISSING_MSG =
  "Delivery distance not available for this address — choose pickup or update address";

export const DELIVERY_TOO_FAR_MSG =
  `Cook delivery is only within ${MAX_SELF_DELIVERY_KM} km — choose pickup or arrange your own drop`;

/**
 * Resolve cook-delivery paise when distance limits may apply.
 * Flag off → flat fee (caller’s base). Pickup / customer-arrange → 0.
 */
export function resolveSelfDeliveryPaise(input: {
  distanceLimitsEnabled: boolean;
  fulfillmentMode: string | null | undefined;
  /** Flat fee in paise when limits off, or for the 3–5 km paid band. */
  flatSelfDeliveryFeePaise: number;
  cookLat?: string | number | null;
  cookLng?: string | number | null;
  addressLat?: string | number | null;
  addressLng?: string | number | null;
  /** Used when address lat/lng missing — pin centroid fallback. */
  addressPinCode?: string | null;
}): {
  deliveryPaise: number;
  band: SelfDeliveryBand | "FLAT" | "ZERO_FULFILLMENT";
  distanceKm: number | null;
} {
  if (isZeroDeliveryFulfillment(input.fulfillmentMode)) {
    return { deliveryPaise: 0, band: "ZERO_FULFILLMENT", distanceKm: null };
  }

  const flat = Math.max(0, Math.round(input.flatSelfDeliveryFeePaise));
  if (!input.distanceLimitsEnabled) {
    return { deliveryPaise: flat, band: "FLAT", distanceKm: null };
  }

  const cook = parseLatLng(input.cookLat, input.cookLng);
  const addr = resolveAddressLatLng({
    lat: input.addressLat,
    lng: input.addressLng,
    pinCode: input.addressPinCode,
  });
  if (!cook || !addr) {
    return { deliveryPaise: 0, band: "MISSING_COORDS", distanceKm: null };
  }

  const distanceKm = haversineKm(cook, addr);
  const band = selfDeliveryBand(distanceKm);
  if (band === "FREE") return { deliveryPaise: 0, band, distanceKm };
  if (band === "PAID") return { deliveryPaise: flat, band, distanceKm };
  return { deliveryPaise: 0, band: "TOO_FAR", distanceKm };
}

/** Throw when band blocks cook delivery (flag on). */
export function assertSelfDeliveryAllowed(band: SelfDeliveryBand | "FLAT" | "ZERO_FULFILLMENT"): void {
  if (band === "MISSING_COORDS") throw new Error(DELIVERY_DISTANCE_MISSING_MSG);
  if (band === "TOO_FAR") throw new Error(DELIVERY_TOO_FAR_MSG);
}
