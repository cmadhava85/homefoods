import { DEFAULT_LOCALE, isLocale, parseLocale, type Locale, LOCALES } from "./locales.js";
import { messages as baseMessages } from "./messages.js";
import { moduleMessages, type ModuleMsgKey } from "./modules.js";
import { waFlowMessages, type WaFlowMsgKey } from "./waFlow.js";

export const messages = {
  en: { ...baseMessages.en, ...moduleMessages.en, ...waFlowMessages.en },
  ta: { ...baseMessages.ta, ...moduleMessages.ta, ...waFlowMessages.ta },
};

export type MsgKey = keyof typeof baseMessages.en | ModuleMsgKey | WaFlowMsgKey;

export { DEFAULT_LOCALE, isLocale, parseLocale, LOCALES };
export type { Locale };

type Params = Record<string, string | number>;

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] != null ? String(params[key]) : `{${key}}`,
  );
}

export function t(locale: Locale, key: MsgKey, params?: Params): string {
  const table = (messages[locale] ?? messages[DEFAULT_LOCALE]) as Record<string, string>;
  const fallback = (messages[DEFAULT_LOCALE] as Record<string, string>)[key];
  const raw = table[key] ?? fallback ?? key;
  return interpolate(raw, params);
}

/** English catalog value → message key (for legacy Error.message strings). */
const enValueToKey: Map<string, MsgKey> = (() => {
  const map = new Map<string, MsgKey>();
  for (const [key, value] of Object.entries(messages.en) as [MsgKey, string][]) {
    map.set(value, key);
  }
  const extras: Array<[string, MsgKey]> = [
    ["Choose a delivery address from your saved list", "error.chooseAddressList"],
    ["Enter a valid Indian mobile number", "error.mobileInvalid"],
    ["PIN code must be 6 digits", "error.pinInvalid"],
    ["Enter your name (at least 2 characters)", "error.nameShort"],
    ["Nothing to update", "error.nothingToUpdate"],
    ["Customer not found", "error.customerNotFound"],
    ["Kitchen not found", "error.kitchenNotFound"],
    ["Order not found", "error.orderNotFound"],
    ["Not found", "error.notFound"],
    ["Unauthorized", "error.unauthorized"],
    ["Sign in as customer", "error.signInCustomer"],
    ["That plate is not available", "error.plateUnavailable"],
    ["Menu item not found", "error.menuNotFound"],
    ["Cannot order for a past date", "error.pastDate"],
    ["Advance orders are limited to the next 7 days", "error.advanceLimit"],
    ["Pick a valid service date", "error.invalidServiceDate"],
    ["This order can’t be cancelled anymore", "error.cannotCancel"],
    ["This order can't be cancelled anymore", "error.cannotCancel"],
    ["That order can’t move to that status right now", "error.orderTransition"],
    ["That order can't move to that status right now", "error.orderTransition"],
    [
      "This kitchen isn’t ready to take paid orders yet — it needs LIVE status, FSSAI, and payout details",
      "error.cookNotReady",
    ],
    [
      "This kitchen isn't ready to take paid orders yet — it needs LIVE status, FSSAI, and payout details",
      "error.cookNotReady",
    ],
    ["OTP expired — tap Send OTP again (dev code is 123456)", "error.otpExpired"],
    ["Invalid OTP", "error.otpInvalid"],
    ["This kitchen is not offering pickup right now", "error.pickupOff"],
    ["Could not verify the request", "error.verifyRequest"],
    ["bad signature", "error.verifyRequest"],
    ["Mock pay is off — use the real UPI link", "error.mockPayOff"],
    ["Something went wrong — please try again", "error.generic"],
    ["Enter a fuller address (tower / flat / street)", "error.addressLineShort"],
    ["Choose a delivery address", "error.chooseAddress"],
  ];
  for (const [en, key] of extras) map.set(en, key);
  return map;
})();

/**
 * Localize an API/WA error string: message keys, known English copy, or passthrough.
 * Also sanitizes DB/driver noise.
 */
/** Catalog key for a known API/business error string, if any. */
export function knownErrorKey(raw: string): MsgKey | null {
  const msg = (raw ?? "").trim();
  if (!msg) return null;
  if (msg in messages.en) return msg as MsgKey;
  return enValueToKey.get(msg) ?? null;
}

export function localizeError(locale: Locale, raw: string): string {
  const msg = (raw ?? "").trim();
  if (!msg) return t(locale, "error.generic");

  // Idempotent-create races (HTTP 409): tell the user it already went through, without DB text.
  if (/duplicate key|unique constraint/i.test(msg)) {
    return t(locale, "error.conflict");
  }

  if (
    /violates foreign key|ECONNREFUSED|ECONNRESET|connection refused|postgres|drizzle|SQLITE|syntax error at/i.test(
      msg,
    )
  ) {
    return t(locale, "error.generic");
  }

  const key = knownErrorKey(msg);
  if (key) return t(locale, key);

  const exists = msg.match(/^You already have a (\w+) address/i);
  if (exists) {
    return t(locale, "error.addressExists", { label: exists[1].toUpperCase() });
  }
  const noLabel = msg.match(/^No (\w+) address saved/i);
  if (noLabel) {
    return t(locale, "error.noLabelAddress", { label: noLabel[1].toUpperCase() });
  }

  return msg;
}

export function validateMobile(value: string): MsgKey | null {
  const digits = value.replace(/\D/g, "");
  if (!value.trim()) return "login.mobileRequired";
  if (digits.length < 10) return "login.mobileInvalid";
  return null;
}

export function validateOtp(value: string): MsgKey | null {
  if (!value.trim()) return "login.otpRequired";
  if (!/^\d{6}$/.test(value.trim())) return "login.otpInvalid";
  return null;
}

export function validateFullName(value: string): MsgKey | null {
  if (value.trim().length < 2) return "account.nameRequired";
  return null;
}

export function validatePin(value: string): MsgKey | null {
  if (!/^\d{6}$/.test(value.replace(/\D/g, "").slice(0, 6))) return "account.pinInvalid";
  return null;
}

export function validateAddressLine(value: string): MsgKey | null {
  if (value.trim().length < 5) return "address.lineRequired";
  return null;
}

/** Pick English or Tamil dish name for display. */
export function localizedDishName(
  locale: Locale,
  item: { itemName: string; itemNameTa?: string | null },
): string {
  if (locale === "ta") {
    const ta = item.itemNameTa?.trim();
    if (ta) return ta;
  }
  return item.itemName;
}

/** Localized short weekday for WhatsApp display (commands still use Mon/Tue…). */
export function localizedWeekday(locale: Locale, dayOfWeek: number): string {
  const d = ((dayOfWeek % 7) + 7) % 7;
  return t(locale, `wa.day.${d}` as MsgKey);
}

/** Localized meal period label for WhatsApp display. */
export function localizedMealPeriod(
  locale: Locale,
  meal: "BREAKFAST" | "LUNCH" | "DINNER" | string,
): string {
  const key =
    meal === "BREAKFAST"
      ? "wa.meal.breakfast"
      : meal === "DINNER"
        ? "wa.meal.dinner"
        : "wa.meal.lunch";
  return t(locale, key as MsgKey);
}
