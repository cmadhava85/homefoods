/**
 * Temporary single-kitchen launch overlay (API side).
 * Set SOLO_KITCHEN_SLUG to filter GET /kitchens and reject POST /cooks/apply.
 * Platform fee / cook commission are admin-editable (services/platformSettings.ts);
 * solo mode only seeds the fee at ₹0 on first boot. Delivery fee only when Admin flag
 * `self_delivery_fee_enabled` is on (cook flat_self_delivery_fee, seed CSK ₹25).
 * Unset solo env to restore multi-cook.
 */
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
