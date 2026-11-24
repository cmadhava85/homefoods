/** Canonical public origin for metadata, robots and sitemap. */
export function siteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/** Signed-in, transactional or internal areas that must never be indexed. */
export const NO_INDEX_PATHS = [
  "/admin",
  "/cook/",
  "/account",
  "/orders",
  "/order/",
  "/pay/",
  "/family",
  "/login",
  "/wa",
  "/lm-api/",
];

export const LEGAL_PATHS = [
  "/legal/terms",
  "/legal/privacy",
  "/legal/refunds",
  "/legal/delivery",
  "/legal/contact",
] as const;
