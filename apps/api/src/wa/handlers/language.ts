import { publicErrorMessage } from "../../httpErrors.js";
import { t as i18nT, type Locale } from "@localmeals/i18n";
import type { WaSession } from "../session.js";

export async function handleLanguage(s: WaSession): Promise<object> {
  const { db, from, text, intent, wa, mobile, replies, ensureCustomerUser } = s;
  let { waLocale } = { waLocale: s.waLocale };

  if (intent === "LANGUAGE") {
    const raw = text.trim().toLowerCase();
    let next: Locale | null = null;
    if (/\bta(mil)?\b/.test(raw) || raw.includes("தமிழ்") || raw.includes("மொழி தமிழ்")) {
      next = "ta";
    } else if (/\ben(glish)?\b/.test(raw) || raw.includes("ஆங்கிலம்")) {
      next = "en";
    }
    if (!next) {
      await wa.send({
        to: from,
        body: i18nT(waLocale, "wa.langHelp"),
        buttons: ["Language English", "Language Tamil", "Menu"],
      });
      return { ok: true, intent, needLang: true, replies: replies() };
    }
    try {
      await ensureCustomerUser(db, mobile, { preferredLanguage: next });
      s.waLocale = next;
      waLocale = next;
      await wa.send({
        to: from,
        body: next === "ta" ? i18nT("ta", "wa.langSetTa") : i18nT("en", "wa.langSet"),
        buttons: ["Menu", "Addresses", "Help"],
      });
      return { ok: true, intent, locale: next, replies: replies() };
    } catch (e) {
      const msg = publicErrorMessage(e, waLocale);
      await wa.send({ to: from, body: msg, buttons: ["Menu"] });
      return { ok: true, intent, error: msg, replies: replies() };
    }
  }

  return { ok: true, intent, unhandled: true as const, replies: replies() };
}
