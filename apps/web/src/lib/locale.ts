import { DEFAULT_LOCALE, isLocale, type Locale } from "@localmeals/i18n";

export const LOCALE_STORAGE_KEY = "lm_locale";

export function readStoredLocale(): Locale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(raw)) return raw;
  } catch {
    /* ignore */
  }
  return DEFAULT_LOCALE;
}

export function localeHeaders(): HeadersInit {
  const locale = readStoredLocale();
  return {
    "X-Locale": locale,
    "Accept-Language": locale,
  };
}
