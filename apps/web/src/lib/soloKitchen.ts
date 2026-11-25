/**
 * Temporary single-kitchen launch overlay (CSK Homemade Delights).
 * Set NEXT_PUBLIC_SOLO_KITCHEN_SLUG (and SOLO_KITCHEN_SLUG on the API) to the
 * kitchen slug. SSR also accepts SOLO_KITCHEN_SLUG so fee display matches API
 * when only the server env is set. Unset both to restore multi-cook.
 */
export function soloKitchenSlug(): string | null {
  const fromPublic = (process.env.NEXT_PUBLIC_SOLO_KITCHEN_SLUG ?? "").trim().toLowerCase();
  const fromServer =
    typeof window === "undefined"
      ? (process.env.SOLO_KITCHEN_SLUG ?? "").trim().toLowerCase()
      : "";
  const raw = fromPublic || fromServer;
  if (!raw || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) return null;
  return raw;
}

export function isSoloKitchenMode(): boolean {
  return soloKitchenSlug() != null;
}

/** Customer “browse kitchens” destination while solo mode is on. */
export function kitchensBrowseHref(): string {
  const slug = soloKitchenSlug();
  return slug ? `/kitchen/${slug}` : "/discover";
}

export function hideCookOnboard(): boolean {
  if (isSoloKitchenMode()) return true;
  const v = (process.env.NEXT_PUBLIC_HIDE_COOK_ONBOARD ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Fallback platform fee until the live admin value (`/meta/features` → pricing) loads.
 * Mirrors the API's first-boot seed: ₹7 normally, ₹0 during solo launch.
 */
export function platformFeePaise(): number {
  return isSoloKitchenMode() ? 0 : 700;
}
