/** Known platform flags (Admin → Features). Defaults are safe for launch. */
export const FEATURE_FLAG_DEFS = [
  {
    key: "ordering_enabled",
    label: "Customer ordering",
    description: "Master switch — blocks new orders / week cart / late requests when off.",
    defaultEnabled: true,
  },
  {
    key: "late_orders_enabled",
    label: "Late orders",
    description: "Allow post–cut-off late requests (cook accept → pay).",
    defaultEnabled: true,
  },
  {
    key: "child_pays_enabled",
    label: "Child Pays / Family",
    description: "Family invite + bill a linked payer on week cart. Off for solo launch.",
    defaultEnabled: false,
  },
  {
    key: "week_discount_enabled",
    label: "Week cart discounts",
    description: "Apply cook % off food when cart meets min days.",
    defaultEnabled: true,
  },
  {
    key: "reviews_enabled",
    label: "Reviews",
    description: "Customers can rate after delivery; public stars on kitchens.",
    defaultEnabled: true,
  },
  {
    key: "whatsapp_outbound_enabled",
    label: "WhatsApp outbound",
    description: "Worker sends WA (pay links, status, invites). Inbound webhook still works.",
    defaultEnabled: true,
  },
  {
    key: "kitchen_follow_enabled",
    label: "Kitchen follow alerts",
    description: "Customers can follow kitchens for menu WhatsApp alerts.",
    defaultEnabled: true,
  },
  {
    key: "eod_settlement_enabled",
    label: "EOD settlement job",
    description: "Scheduler / Run EOD creates cook settlement batches.",
    defaultEnabled: true,
  },
  {
    key: "pickup_enabled",
    label: "Kitchen pickup",
    description:
      "Customers can choose pickup (₹0 delivery) in a restricted window. Landmark after pay only. Keep OFF in prod until ready.",
    defaultEnabled: false,
  },
  {
    key: "partner_delivery_enabled",
    label: "Partner delivery",
    description:
      "Cooks with delivery type PARTNER get rider assign on dispatch (mock or real logistics). Keep OFF until a pin is ready.",
    defaultEnabled: false,
  },
  {
    key: "lean_wa_status_enabled",
    label: "Lean WA status (opt-in)",
    description:
      "Customers who opt in get sparse Confirmed / Cooking / Ready WhatsApp pings. Default OFF — keeps outbound lean.",
    defaultEnabled: false,
  },
  {
    key: "delivery_distance_limits_enabled",
    label: "Delivery distance limits",
    description:
      "Free cook delivery within 3 km, flat cook fee 3–5 km, block cook delivery beyond 5 km. Needs kitchen + address lat/lng. Keep OFF until coords are reliable.",
    defaultEnabled: false,
  },
  {
    key: "self_delivery_fee_enabled",
    label: "Self delivery fee",
    description:
      "Charge cook flat_self_delivery_fee on DELIVERY checkouts (e.g. ₹25). Off = ₹0 delivery. Independent of platform ₹7. Keep OFF for free-delivery launch.",
    defaultEnabled: false,
  },
] as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_DEFS)[number]["key"];

export type FeatureFlagsMap = Record<FeatureFlagKey, boolean>;

export function defaultFeatureFlags(): FeatureFlagsMap {
  const out = {} as FeatureFlagsMap;
  for (const d of FEATURE_FLAG_DEFS) {
    out[d.key] = d.defaultEnabled;
  }
  return out;
}

export function isFeatureEnabled(
  flags: Partial<Record<string, boolean>> | null | undefined,
  key: FeatureFlagKey,
): boolean {
  if (flags && key in flags && typeof flags[key] === "boolean") {
    return flags[key] as boolean;
  }
  const def = FEATURE_FLAG_DEFS.find((d) => d.key === key);
  return def?.defaultEnabled ?? true;
}
