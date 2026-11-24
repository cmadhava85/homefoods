import { DEFAULT_LOCALE, isLocale, type Locale } from "@localmeals/i18n";

export const LOCALE_STORAGE_KEY = "lm_locale";
export const LOCALE_COOKIE = "lm_locale";

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

export function writeLocaleCookie(locale: Locale) {
  if (typeof document === "undefined") return;
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${maxAge}; samesite=lax`;
}

export function localeHeaders(): HeadersInit {
  const locale = readStoredLocale();
  return {
    "X-Locale": locale,
    "Accept-Language": locale,
  };
}
