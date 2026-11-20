/**
 * Temporary single-kitchen launch overlay (API side).
 * Set SOLO_KITCHEN_SLUG to filter GET /kitchens and reject POST /cooks/apply.
 * While on: platform fee is ₹0. Delivery fee only when Admin flag
 * `self_delivery_fee_enabled` is on (cook flat_self_delivery_fee, seed CSK ₹25).
 * Unset solo env to restore multi-cook + ₹7 fee.
 */
import {
  PLATFORM_FEE_PAISE,
  platformFeePaiseForCheckoutLine as domainPlatformFeeForLine,
} from "@localmeals/domain";

export function soloKitchenSlug(): string | null {
  // Prefer API env; fall back to NEXT_PUBLIC so local monorepo stays in sync.
  const raw = (
    process.env.SOLO_KITCHEN_SLUG ??
    process.env.NEXT_PUBLIC_SOLO_KITCHEN_SLUG ??
    ""
  )
    .trim()
    .toLowerCase();
  if (!raw || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) return null;
  return raw;
}

export function isSoloKitchenMode(): boolean {
  return soloKitchenSlug() != null;
}

/** ₹7 once per checkout normally; ₹0 during solo launch. */
export function platformFeePaise(): number {
  return isSoloKitchenMode() ? 0 : PLATFORM_FEE_PAISE;
}

/** Week-cart line fee — first line only outside solo; always 0 in solo. */
export function platformFeePaiseForCheckoutLine(lineIndex: number): number {
  if (isSoloKitchenMode()) return 0;
  return domainPlatformFeeForLine(lineIndex);
}
