import { createHmac, timingSafeEqual } from "node:crypto";

export type WhatsAppTemplate = {
  /** Approved template name, e.g. lunch_pay_link */
  name: string;
  language?: string;
  /** Body {{1}}, {{2}}, … */
  bodyParams?: string[];
};

export type WhatsAppMessage = {
  to: string;
  /** Free-form body (inside 24h customer-care window). Ignored if `template` is set. */
  body: string;
  buttons?: string[];
  /** Utility/marketing template for outbound outside the 24h window. */
  template?: WhatsAppTemplate;
};

export type WhatsAppProvider = {
  send(message: WhatsAppMessage): Promise<{ messageId: string }>;
  verifyWebhook(query: Record<string, string | undefined>): boolean;
  /** Meta X-Hub-Signature-256 over raw body (optional for mock). */
  verifyIncomingSignature?(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): boolean;
};

/** True when Meta credentials look configured (not empty / REPLACE_ME). */
export function isWhatsAppConfigured(): boolean {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? "";
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "";
  const verify = process.env.WHATSAPP_VERIFY_TOKEN?.trim() ?? "";
  const appSecret = process.env.WHATSAPP_APP_SECRET?.trim() ?? "";
  const bad = (v: string) => !v || v === "REPLACE_ME";
  return !bad(token) && !bad(phoneId) && !bad(verify) && !bad(appSecret);
}

function digitsOnly(mobile: string): string {
  return mobile.replace(/\D/g, "");
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export class MockWhatsAppProvider implements WhatsAppProvider {
  public sent: WhatsAppMessage[] = [];

  async send(message: WhatsAppMessage) {
    this.sent.push(message);
    console.log("[mock-whatsapp]", JSON.stringify(message));
    return { messageId: `wa_mock_${Date.now()}` };
  }

  verifyWebhook(query: Record<string, string | undefined>): boolean {
    const token = process.env.WHATSAPP_VERIFY_TOKEN ?? "localmeals-dev";
    return query["hub.verify_token"] === token;
  }

  verifyIncomingSignature(): boolean {
    return true;
  }
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  async send(message: WhatsAppMessage) {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    const apiVersion = process.env.WHATSAPP_API_VERSION ?? "v21.0";
    if (!phoneId || !token || phoneId === "REPLACE_ME" || token === "REPLACE_ME") {
      throw new Error("WhatsApp credentials missing — use MOCK_WHATSAPP=true");
    }

    const to = digitsOnly(message.to);
    const url = `https://graph.facebook.com/${apiVersion}/${phoneId}/messages`;

    let payload: Record<string, unknown>;
    if (message.template) {
      const components: Array<Record<string, unknown>> = [];
      if (message.template.bodyParams?.length) {
        components.push({
          type: "body",
          parameters: message.template.bodyParams.map((text) => ({
            type: "text",
            text: String(text).slice(0, 1024),
          })),
        });
      }
      payload = {
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: message.template.name,
          language: { code: message.template.language ?? "en" },
          ...(components.length ? { components } : {}),
        },
      };
    } else {
      const buttons = (message.buttons ?? [])
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 3);
      payload =
        buttons.length > 0
          ? {
              messaging_product: "whatsapp",
              to,
              type: "interactive",
              interactive: {
                type: "button",
                body: { text: message.body.slice(0, 1024) },
                action: {
                  buttons: buttons.map((title, i) => ({
                    type: "reply",
                    reply: {
                      id: `btn_${i}_${title}`.slice(0, 256),
                      title: title.slice(0, 20),
                    },
                  })),
                },
              },
            }
          : {
              messaging_product: "whatsapp",
              to,
              type: "text",
              text: { preview_url: false, body: message.body.slice(0, 4096) },
            };
    }

    const { fetchWithTimeout, UpstreamHttpError } = await import("./fetchWithTimeout.js");
    const timeoutMs = Number(process.env.WHATSAPP_TIMEOUT_MS ?? 8_000);
    try {
      const { json } = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
        { timeoutMs, retries: 0, provider: "whatsapp", path: `/messages` },
      );
      const body = (json ?? {}) as {
        messages?: Array<{ id?: string }>;
        error?: { message?: string; code?: number; error_subcode?: number };
      };
      if (body.error?.message) {
        throw new Error(formatMetaError(body.error));
      }
      return { messageId: body.messages?.[0]?.id ?? `wa_meta_${Date.now()}` };
    } catch (err) {
      if (err instanceof UpstreamHttpError) {
        // Preserve Meta (#code) text so isNonRetryableWhatsAppError can park allowlist failures.
        const meta = metaErrorFromBody(err.bodyJson);
        const message = meta ? formatMetaError(meta) : err.message;
        throw Object.assign(new Error(message), { statusCode: err.statusCode, name: "UpstreamError" });
      }
      throw err;
    }
  }

  verifyWebhook(query: Record<string, string | undefined>): boolean {
    return query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN;
  }

  verifyIncomingSignature(
    headers: Record<string, string | undefined>,
    rawBody: string,
  ): boolean {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) return false;
    const header =
      headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"] ?? "";
    const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    return safeEqualHex(expected, header);
  }
}

let singleton: WhatsAppProvider | null = null;

export function getWhatsAppProvider(): WhatsAppProvider {
  if (!singleton) {
    singleton =
      process.env.MOCK_WHATSAPP !== "false"
        ? new MockWhatsAppProvider()
        : new MetaWhatsAppProvider();
  }
  return singleton;
}

type MetaErrorBody = { message?: string; code?: number; error_subcode?: number };

function metaErrorFromBody(json: unknown): MetaErrorBody | null {
  if (!json || typeof json !== "object") return null;
  const err = (json as { error?: MetaErrorBody }).error;
  return err?.message ? err : null;
}

function formatMetaError(error: MetaErrorBody): string {
  const detail = error.message ?? "WhatsApp error";
  return typeof error.code === "number" ? `(#${error.code}) ${detail}` : detail;
}

/**
 * Meta errors that will not succeed on retry (test allowlist, opt-out, etc.).
 * Outbox should mark these processed so the queue does not spin forever.
 */
export function isNonRetryableWhatsAppError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /#131030\b/.test(msg) || // recipient not in allowed list (dev/test)
    /#131047\b/.test(msg) || // re-engagement message
    /#131026\b/.test(msg) || // undeliverable
    /#133010\b/.test(msg) || // account issue
    /not in allowed list/i.test(msg) ||
    /re-engagement/i.test(msg)
  );
}

/** Reset singleton (tests). */
export function resetWhatsAppProvider() {
  singleton = null;
}

export type WhatsAppIntent =
  | "MENU"
  | "ORDER"
  | "LATE"
  | "PAY"
  | "CANCEL"
  | "ORDERS"
  | "WEEK"
  | "FOLLOW"
  | "UNFOLLOW"
  | "HELP"
  | "ADDRESSES"
  | "SAVE_ADDRESS"
  | "LANGUAGE"
  | "PICK"
  | "FAMILY"
  | "FAMILY_ACCEPT"
  | "REVIEW"
  | "STOP"
  | "START"
  | "REORDER"
  | "COOK_STATUS"
  | "COOK_COOKING"
  | "COOK_PACK"
  | "COOK_DISPATCH"
  | "COOK_DELIVER"
  | "COOK_LATE_LIST"
  | "COOK_LATE_ACCEPT"
  | "COOK_LATE_DECLINE"
  | "COOK_MENU_ADD"
  | "COOK_MENU_LIST"
  | "COOK_MENU_SKIP"
  | "COOK_MENU_PHOTO"
  | "COOK_CANCEL_LIST"
  | "UNKNOWN";

export type WaAddressLabel = "HOME" | "OFFICE" | "OTHER";

export function parseAddressLabelToken(raw: string): WaAddressLabel | undefined {
  const t = raw.trim().toLowerCase();
  if (t === "home" || t === "house") return "HOME";
  if (t === "office" || t === "work") return "OFFICE";
  if (t === "other") return "OTHER";
  return undefined;
}

/** Bare 1–9 for guided checkout picks. */
export function parsePickNumber(text: string): number | undefined {
  const m = text.trim().match(/^([1-9])\s*[.)]?$/);
  if (!m) return undefined;
  return Number(m[1]);
}

function normalizeWaIntentText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[!.?,]+$/g, "")
    .replace(/\s+/g, " ");
}

export function parseWhatsAppIntent(text: string): {
  intent: WhatsAppIntent;
  raw: string;
} {
  const t = normalizeWaIntentText(text);
  // Guided checkout: reply with a single digit
  if (parsePickNumber(text) != null) {
    return { intent: "PICK", raw: text };
  }
  // Marketing opt-out / opt-in (Meta-style STOP / START)
  if (
    t === "stop" ||
    t === "unsubscribe" ||
    t === "opt out" ||
    t === "opt-out" ||
    t === "stop messages" ||
    t === "நிறுத்து"
  ) {
    return { intent: "STOP", raw: text };
  }
  if (
    t === "start alerts" ||
    t === "resume" ||
    t === "opt in" ||
    t === "opt-in" ||
    t === "subscribe" ||
    t === "தொடங்கு"
  ) {
    return { intent: "START", raw: text };
  }
  // Repeat last kitchen (same as yesterday / again)
  if (
    t === "again" ||
    t === "same" ||
    t === "same as yesterday" ||
    t === "reorder" ||
    t === "same order" ||
    t === "மீண்டும்" ||
    t === "அதே"
  ) {
    return { intent: "REORDER", raw: text };
  }
  // First-time / casual openers → same as Menu (Tanglish + Tamil synonyms)
  if (
    t === "hi" ||
    t === "hello" ||
    t === "hey" ||
    t === "start" ||
    t === "order food" ||
    t === "lunch" ||
    t === "hi!" ||
    t === "வணக்கம்" ||
    t === "saapadu" ||
    t === "சாப்பாடு" ||
    t === "menu kaatu" ||
    t === "menukaatu" ||
    t === "food" ||
    t === "hungry" ||
    t === "மெனு"
  ) {
    return { intent: "MENU", raw: text };
  }
  // Cook kitchen ops (before customer Menu/Order)
  if (t === "status" || t === "desk" || t === "kitchen status") {
    return { intent: "COOK_STATUS", raw: text };
  }
  if (
    t === "late requests" ||
    t === "pending late" ||
    t === "lates" ||
    t === "late pending"
  ) {
    return { intent: "COOK_LATE_LIST", raw: text };
  }
  if (
    t === "accept family" ||
    t === "family accept" ||
    t.startsWith("accept family") ||
    t.startsWith("family accept")
  ) {
    return { intent: "FAMILY_ACCEPT", raw: text };
  }
  if (t.startsWith("family")) {
    return { intent: "FAMILY", raw: text };
  }
  if (t.startsWith("review")) {
    return { intent: "REVIEW", raw: text };
  }
  if (t.startsWith("accept") || t.startsWith("approve")) {
    return { intent: "COOK_LATE_ACCEPT", raw: text };
  }
  if (t.startsWith("decline") || t.startsWith("reject")) {
    return { intent: "COOK_LATE_DECLINE", raw: text };
  }
  if (t === "cooking" || t === "start cooking" || t === "mark cooking") {
    return { intent: "COOK_COOKING", raw: text };
  }
  if (t === "packed" || t === "mark packed" || t === "pack") {
    return { intent: "COOK_PACK", raw: text };
  }
  if (t === "dispatched" || t === "mark dispatched" || t === "dispatch") {
    return { intent: "COOK_DISPATCH", raw: text };
  }
  if (t.startsWith("delivered") || t.startsWith("deliver ")) {
    return { intent: "COOK_DELIVER", raw: text };
  }
  // Cook menu posting (before customer Menu)
  if (
    t === "my menu" ||
    t === "menu today" ||
    t === "today menu" ||
    t === "today's menu" ||
    t === "todays menu"
  ) {
    return { intent: "COOK_MENU_LIST", raw: text };
  }
  if (
    t.startsWith("add ") ||
    t.startsWith("post ") ||
    t.startsWith("menu add ") ||
    t.startsWith("add menu ")
  ) {
    return { intent: "COOK_MENU_ADD", raw: text };
  }
  if (t === "skip" || t === "skip photo" || t === "no photo") {
    return { intent: "COOK_MENU_SKIP", raw: text };
  }
  if (
    t === "cancel requests" ||
    t === "cancel asks" ||
    t === "pending cancel" ||
    t === "cancels"
  ) {
    return { intent: "COOK_CANCEL_LIST", raw: text };
  }
  // Order / Late before Menu so "Order …" never matches menu
  if (t.startsWith("late") || t.includes("late order")) return { intent: "LATE", raw: text };
  if (
    t === "orders" ||
    t === "my orders" ||
    t === "order history" ||
    t.startsWith("orders ")
  ) {
    return { intent: "ORDERS", raw: text };
  }
  if (t.startsWith("week")) return { intent: "WEEK", raw: text };
  if (t.startsWith("unfollow")) return { intent: "UNFOLLOW", raw: text };
  if (t.startsWith("follow")) return { intent: "FOLLOW", raw: text };
  if (t.startsWith("order") || t.includes("order lunch")) return { intent: "ORDER", raw: text };
  if (t === "cancel" || t.startsWith("cancel ")) return { intent: "CANCEL", raw: text };
  if (t === "pay" || t.startsWith("pay ") || t.includes("pay now")) {
    return { intent: "PAY", raw: text };
  }
  if (
    t === "addresses" ||
    t === "address" ||
    t === "my addresses" ||
    t === "my address"
  ) {
    return { intent: "ADDRESSES", raw: text };
  }
  if (t.startsWith("save address") || t.startsWith("save home") || t.startsWith("save office") || t.startsWith("save other")) {
    return { intent: "SAVE_ADDRESS", raw: text };
  }
  if (
    t === "language" ||
    t.startsWith("language ") ||
    t === "மொழி" ||
    t.startsWith("மொழி ") ||
    t === "tamil" ||
    t === "english" ||
    t === "தமிழ்"
  ) {
    return { intent: "LANGUAGE", raw: text };
  }
  if (t === "help" || t.includes("help") || t === "உதவி") return { intent: "HELP", raw: text };
  if (
    t === "menu" ||
    t.startsWith("menu ") ||
    /\bmenu\b/.test(t) ||
    t.includes("kaatu") ||
    t === "list"
  ) {
    return { intent: "MENU", raw: text };
  }
  // Bare kitchen slug from a button → open that kitchen’s menu
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(t)) return { intent: "MENU", raw: text };
  return { intent: "UNKNOWN", raw: text };
}

/** Parse "Delivered LM-1234" or "deliver LM-1234". */
export function parseDeliverCommand(text: string): { publicId?: string } {
  const m = text.trim().match(/^deliver(?:ed)?\s+(LM-[A-Z0-9]+)/i);
  return { publicId: m?.[1]?.toUpperCase() };
}

/** Parse "Accept LM-1234" / "Approve late LM-1234". */
export function parseLateDecideCommand(text: string): { publicId?: string } {
  const m = text.trim().match(/^(?:accept|approve|decline|reject)(?:\s+late)?\s+(LM-[A-Z0-9]+)/i);
  return { publicId: m?.[1]?.toUpperCase() };
}

/** Parse "Pay", "Pay LM-1234", or "Pay CHK-1234". */
export function parsePayCommand(text: string): { publicId?: string; checkoutId?: string } {
  const m = text.trim().match(/^pay(?:\s+((?:LM|CHK)-[A-Z0-9]+))?$/i);
  if (!m) return {};
  const id = m[1]?.toUpperCase();
  if (!id) return {};
  if (id.startsWith("CHK-")) return { checkoutId: id };
  return { publicId: id };
}

/** Parse "Follow csk-homemade-delights" / "Unfollow csk-homemade-delights". */
export function parseFollowCommand(text: string): { slug?: string } {
  const m = text.trim().match(/^(?:un)?follow(?:\s+([a-z0-9-]+))?$/i);
  return { slug: m?.[1]?.toLowerCase() };
}

const WEEK_MEAL_ALIAS: Record<string, "BREAKFAST" | "LUNCH" | "DINNER"> = {
  breakfast: "BREAKFAST",
  bf: "BREAKFAST",
  b: "BREAKFAST",
  lunch: "LUNCH",
  l: "LUNCH",
  dinner: "DINNER",
  din: "DINNER",
  d: "DINNER",
};

/**
 * Parse week / advance cart commands:
 * - Week csk-homemade-delights
 * - Week csk-homemade-delights lunch
 * - Week csk-homemade-delights lunch all
 * - Week csk-homemade-delights L all 2
 * - Week csk-homemade-delights dinner Mon Wed Fri
 */
export function parseWeekCommand(text: string): {
  slug?: string;
  mealType?: "BREAKFAST" | "LUNCH" | "DINNER";
  addressLabel?: WaAddressLabel;
  fulfillmentMode?: "DELIVERY" | "PICKUP" | "CUSTOMER_ARRANGE";
  payerMobile?: string;
  all?: boolean;
  itemIndex?: number;
  dayTokens?: string[];
} {
  const raw = text.trim();
  const m = raw.match(/^week(?:\s+([a-z0-9-]+))?(?:\s+(.+))?$/i);
  if (!m) return {};
  const slug = m[1]?.toLowerCase();
  let rest = (m[2] ?? "").trim();
  if (!rest) return { slug };

  let mealType: "BREAKFAST" | "LUNCH" | "DINNER" | undefined;
  const mealHead = rest.match(/^([a-z]+)(?:\s+|$)/i);
  if (mealHead) {
    const aliased = WEEK_MEAL_ALIAS[mealHead[1].toLowerCase()];
    if (aliased) {
      mealType = aliased;
      rest = rest.slice(mealHead[0].length).trim();
    }
  }

  const extras = stripWaCheckoutExtras(rest);
  rest = extras.rest;
  const { addressLabel, fulfillmentMode, payerMobile } = extras;

  if (!rest) return { slug, mealType, addressLabel, fulfillmentMode, payerMobile };

  const allMatch = rest.match(/^all(?:\s+(\d+))?$/i);
  if (allMatch) {
    return {
      slug,
      mealType,
      addressLabel,
      fulfillmentMode,
      payerMobile,
      all: true,
      itemIndex: allMatch[1] ? Number(allMatch[1]) : 1,
    };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  const maybeIndex = tokens[tokens.length - 1]?.match(/^\d+$/) ? Number(tokens.pop()) : undefined;
  return {
    slug,
    mealType,
    addressLabel,
    fulfillmentMode,
    payerMobile,
    dayTokens: tokens.map((t) => t.toLowerCase()),
    itemIndex: maybeIndex ?? 1,
  };
}

/** Trailing HOME|PICKUP|ARRANGE and optional PAY +mobile on order/week/late commands. */
export function stripWaCheckoutExtras(rest: string): {
  rest: string;
  addressLabel?: WaAddressLabel;
  fulfillmentMode?: "DELIVERY" | "PICKUP" | "CUSTOMER_ARRANGE";
  payerMobile?: string;
} {
  let s = rest.trim();
  let payerMobile: string | undefined;
  const payTail = s.match(/\s+pay\s+(\+?\d{10,15})$/i);
  if (payTail) {
    payerMobile = payTail[1];
    s = s.slice(0, s.length - payTail[0].length).trim();
  }
  let fulfillmentMode: "DELIVERY" | "PICKUP" | "CUSTOMER_ARRANGE" | undefined;
  let addressLabel: WaAddressLabel | undefined;
  // ARRANGE / PORTER = customer arranges auto; may appear with HOME (address still needed).
  const arrangeTail = s.match(/(?:^|\s+)(arrange|porter|customer_arrange)$/i);
  if (arrangeTail) {
    fulfillmentMode = "CUSTOMER_ARRANGE";
    s = s.slice(0, s.length - arrangeTail[0].length).trim();
  }
  const placeTail = s.match(/(?:^|\s+)(home|office|other|house|work|pickup)$/i);
  if (placeTail) {
    const tok = placeTail[1].toLowerCase();
    if (tok === "pickup") fulfillmentMode = "PICKUP";
    else addressLabel = parseAddressLabelToken(tok);
    s = s.slice(0, s.length - placeTail[0].length).trim();
  }
  return { rest: s, addressLabel, fulfillmentMode, payerMobile };
}

/** Parse "Cancel", "Cancel LM-1234", or "Cancel CHK-1234". */
export function parseCancelCommand(text: string): { publicId?: string; checkoutId?: string } {
  const m = text.trim().match(/^cancel(?:\s+((?:LM|CHK)-[A-Z0-9]+))?$/i);
  if (!m) return {};
  const id = m[1]?.toUpperCase();
  if (!id) return {};
  if (id.startsWith("CHK-")) return { checkoutId: id };
  return { publicId: id };
}

/** "Menu", "Menu csk-homemade-delights", or bare "csk-homemade-delights". */
export function parseMenuCommand(text: string): { slug?: string } {
  const raw = text.trim();
  const withMenu = raw.match(/^menu(?:\s+([a-z0-9-]+))?$/i);
  if (withMenu) {
    return { slug: withMenu[1]?.toLowerCase() };
  }
  const bare = raw.match(/^([a-z0-9]+(?:-[a-z0-9]+)+)$/i);
  if (bare) return { slug: bare[1].toLowerCase() };
  return {};
}

/** Parse "Order csk-homemade-delights", "Order csk-homemade-delights 1 HOME", "Order csk-homemade-delights 1 PICKUP PAY 98…". */
export function parseOrderCommand(text: string): {
  slug?: string;
  itemIndex?: number;
  addressLabel?: WaAddressLabel;
  fulfillmentMode?: "DELIVERY" | "PICKUP" | "CUSTOMER_ARRANGE";
  payerMobile?: string;
} {
  const raw = text.trim();
  const withOrder = raw.match(/^order(?:\s+lunch)?\s+([a-z0-9-]+)(?:\s+(\d+))?(?:\s+(.+))?$/i);
  if (!withOrder) return {};
  const extras = stripWaCheckoutExtras(withOrder[3] ?? "");
  return {
    slug: withOrder[1].toLowerCase(),
    itemIndex: withOrder[2] ? Number(withOrder[2]) : undefined,
    addressLabel: extras.addressLabel,
    fulfillmentMode: extras.fulfillmentMode,
    payerMobile: extras.payerMobile,
  };
}

/** Parse "Late csk-homemade-delights", "late csk-homemade-delights 2 HOME", "Late csk-homemade-delights 1 PICKUP". */
export function parseLateCommand(text: string): {
  slug?: string;
  itemIndex?: number;
  addressLabel?: WaAddressLabel;
  fulfillmentMode?: "DELIVERY" | "PICKUP" | "CUSTOMER_ARRANGE";
  payerMobile?: string;
} {
  const raw = text.trim();
  const withLate = raw.match(/^late(?:\s+order)?\s+([a-z0-9-]+)(?:\s+(\d+))?(?:\s+(.+))?$/i);
  if (!withLate) return {};
  const extras = stripWaCheckoutExtras(withLate[3] ?? "");
  return {
    slug: withLate[1].toLowerCase(),
    itemIndex: withLate[2] ? Number(withLate[2]) : undefined,
    addressLabel: extras.addressLabel,
    fulfillmentMode: extras.fulfillmentMode,
    payerMobile: extras.payerMobile,
  };
}

/** Parse "Family 9876543210" / "Family +9198…". */
export function parseFamilyInviteCommand(text: string): { payerMobile?: string } {
  const m = text.trim().match(/^family(?:\s+invite)?\s+(\+?\d{10,15})$/i);
  return m ? { payerMobile: m[1] } : {};
}

/** Parse "Review LM-1234 5 great food". */
export function parseReviewCommand(text: string): {
  publicId?: string;
  rating?: number;
  comment?: string;
} {
  const m = text.trim().match(/^review\s+(LM-[A-Z0-9]+)\s+([1-5])(?:\s+(.+))?$/i);
  if (!m) return {};
  return {
    publicId: m[1].toUpperCase(),
    rating: Number(m[2]),
    comment: m[3]?.trim() || undefined,
  };
}

/** Parse "Save HOME Tower 3…" / "Save address OFFICE: Tidel Park…". */
export function parseSaveAddressCommand(text: string): {
  label?: WaAddressLabel;
  line1?: string;
} {
  const m = text
    .trim()
    .match(/^save(?:\s+address)?\s+(home|office|other|house|work)\s*[:\-]?\s+(.+)$/i);
  if (!m) return {};
  return {
    label: parseAddressLabelToken(m[1]),
    line1: m[2].trim(),
  };
}

export function isMockWhatsApp(provider: WhatsAppProvider): provider is MockWhatsAppProvider {
  return provider instanceof MockWhatsAppProvider;
}

/**
 * Parse cook menu add:
 * - "Add Sambar rice 80"
 * - "Post Chicken biryani 120 nonveg"
 * - "Menu add Idli 40 veg"
 */
export function parseCookMenuAdd(text: string): {
  itemName?: string;
  priceRupees?: number;
  isVeg?: boolean;
} {
  const raw = text.trim();
  const m = raw.match(/^(?:add|post|menu\s+add|add\s+menu)\s+(.+)$/i);
  if (!m) return {};
  let rest = m[1].trim();
  let isVeg = true;
  const vegTail = rest.match(/\s+(non[\s-]?veg|nonveg|nv|veg|vegetarian)$/i);
  if (vegTail) {
    const flag = vegTail[1].toLowerCase().replace(/[\s-]/g, "");
    isVeg = !(flag === "nonveg" || flag === "nv");
    rest = rest.slice(0, rest.length - vegTail[0].length).trim();
  }
  const priceTail = rest.match(/\s+(\d{1,5})$/);
  if (!priceTail) return {};
  const priceRupees = Number(priceTail[1]);
  const itemName = rest.slice(0, rest.length - priceTail[0].length).trim();
  if (!itemName || !Number.isFinite(priceRupees) || priceRupees <= 0) return {};
  return { itemName, priceRupees, isVeg };
}

export type WaInboundImage = {
  mediaId?: string;
  mimeType?: string;
  /** Local mock / simulator: already-hosted path or data. */
  imageUrl?: string;
  imageBase64?: string;
};

export type WaInboundMessage = {
  from?: string;
  text?: string;
  image?: WaInboundImage;
  /** Simulator / client locale hint (`en` | `ta`). Meta webhooks omit this. */
  locale?: string;
  /** Meta Cloud API message id (`wamid.…`) for inbound dedupe. */
  messageId?: string;
};

/** Download Meta media by id → bytes (real WA only). */
export async function downloadWhatsAppMedia(
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? "";
  const apiVersion = process.env.WHATSAPP_API_VERSION ?? "v21.0";
  if (!token || token === "REPLACE_ME") {
    throw new Error("WhatsApp credentials missing — cannot download media");
  }
  const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) {
    throw new Error(`WhatsApp media lookup failed (${metaRes.status})`);
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) throw new Error("WhatsApp media URL missing");
  const binRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!binRes.ok) {
    throw new Error(`WhatsApp media download failed (${binRes.status})`);
  }
  const mimeType = meta.mime_type || binRes.headers.get("content-type") || "image/jpeg";
  const ab = await binRes.arrayBuffer();
  return { buffer: Buffer.from(ab), mimeType };
}

/** Extract inbound text/image from Meta Cloud API or local simulator body. */
export function extractInboundWhatsApp(body: unknown): WaInboundMessage {
  const b = body as {
    from?: string;
    text?: string;
    locale?: string;
    imageUrl?: string;
    imageBase64?: string;
    mimeType?: string;
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: Array<{
            id?: string;
            from: string;
            type?: string;
            text?: { body?: string };
            image?: { id?: string; mime_type?: string; caption?: string };
            interactive?: {
              button_reply?: { title?: string; id?: string };
              list_reply?: { title?: string; id?: string };
            };
            button?: { text?: string; payload?: string };
          }>;
        };
      }>;
    }>;
  };

  const normFrom = (f: string) => (f.startsWith("+") ? f : `+${f}`);
  const locale =
    typeof b.locale === "string" && b.locale.trim() ? b.locale.trim() : undefined;

  if (b.from && (b.imageUrl || b.imageBase64)) {
    return {
      from: normFrom(b.from),
      text: b.text,
      ...(locale ? { locale } : {}),
      image: {
        imageUrl: b.imageUrl,
        imageBase64: b.imageBase64,
        mimeType: b.mimeType ?? "image/jpeg",
      },
    };
  }

  if (b.from && b.text) {
    return {
      from: normFrom(b.from),
      text: b.text,
      ...(locale ? { locale } : {}),
    };
  }

  const msg = b.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg) return {};
  const from = normFrom(msg.from);
  const messageId = typeof msg.id === "string" && msg.id.trim() ? msg.id.trim() : undefined;
  if (msg.type === "image" || msg.image?.id) {
    return {
      from,
      ...(messageId ? { messageId } : {}),
      text: msg.image?.caption,
      image: {
        mediaId: msg.image?.id,
        mimeType: msg.image?.mime_type ?? "image/jpeg",
      },
    };
  }
  const buttonId =
    msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id;
  // Outbound ids are `btn_{i}_{title}` — recover title if Meta omits it.
  const fromButtonId = buttonId?.replace(/^btn_\d+_/, "").trim() || undefined;
  const text =
    msg.text?.body ??
    msg.interactive?.button_reply?.title ??
    msg.interactive?.list_reply?.title ??
    fromButtonId ??
    msg.button?.text ??
    msg.button?.payload;
  return { from, text, ...(messageId ? { messageId } : {}) };
}
