export const LOCALES = ["en", "ta"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "ta";
}

/** Parse Accept-Language / X-Locale / preferred_language. */
export function parseLocale(raw: string | null | undefined): Locale {
  if (!raw) return DEFAULT_LOCALE;
  const primary = raw.split(",")[0]?.trim().toLowerCase() ?? "";
  if (primary.startsWith("ta")) return "ta";
  if (primary.startsWith("en")) return "en";
  if (isLocale(primary)) return primary;
  return DEFAULT_LOCALE;
}
