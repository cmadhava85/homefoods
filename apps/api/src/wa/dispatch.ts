import type { WhatsAppInboundInput } from "./session.js";
import { createWaSession } from "./session.js";
import { handleLanguage } from "./handlers/language.js";
import { handleCookOps } from "./handlers/cookOps.js";
import { handleBrowse } from "./handlers/browse.js";
import { handleHelp } from "./handlers/help.js";
import { handleOrderFlow } from "./handlers/orderFlow.js";
import { handlePay } from "./handlers/pay.js";
import { handleFamilyReview } from "./handlers/familyReview.js";
import { handleOptOut } from "./handlers/optOut.js";
import { handleUnknown } from "./handlers/unknown.js";
import type { WaSession } from "./session.js";

export type { WhatsAppInboundInput } from "./session.js";

type WaHandler = (s: WaSession) => Promise<object>;

const COOK_INTENTS = new Set([
  "COOK_STATUS",
  "COOK_COOKING",
  "COOK_PACK",
  "COOK_DISPATCH",
  "COOK_DELIVER",
  "COOK_LATE_LIST",
  "COOK_LATE_ACCEPT",
  "COOK_LATE_DECLINE",
  "COOK_MENU_ADD",
  "COOK_MENU_LIST",
  "COOK_MENU_SKIP",
  "COOK_MENU_PHOTO",
  "COOK_CANCEL_LIST",
]);

const BROWSE_INTENTS = new Set(["PICK", "MENU", "ADDRESSES", "SAVE_ADDRESS", "REORDER"]);

const ORDER_INTENTS = new Set([
  "ORDERS",
  "FOLLOW",
  "UNFOLLOW",
  "WEEK",
  "ORDER",
  "LATE",
  "CANCEL",
]);

const FAMILY_REVIEW_INTENTS = new Set(["FAMILY", "FAMILY_ACCEPT", "REVIEW"]);

const SESSION_SAFE = new Set([
  "PICK",
  "CANCEL",
  "HELP",
  "LANGUAGE",
  "STOP",
  "START",
  "PAY",
  // Address steps belong to checkout — the bot itself asks for them at PICK_ADDRESS.
  "SAVE_ADDRESS",
  "ADDRESSES",
  // Ordering commands continue/replace the browse flow (often sent from the bot's own buttons).
  "MENU",
  "ORDER",
  "WEEK",
  "REORDER",
  "LATE",
]);

const GUARD_CONTINUE = new Set(["continue", "தொடர்", "தொடர"]);
const GUARD_CLEAR = new Set(["cancel order", "cancel checkout", "start over", "புதிய order"]);

/** Intent registry — add new WhatsApp intents here (OCP). */
const INTENT_HANDLERS: Record<string, WaHandler> = {
  LANGUAGE: handleLanguage,
  HELP: handleHelp,
  PAY: handlePay,
  STOP: handleOptOut,
  START: handleOptOut,
};

function resolveHandler(intent: string): WaHandler {
  if (COOK_INTENTS.has(intent)) return handleCookOps;
  if (BROWSE_INTENTS.has(intent)) return handleBrowse;
  if (ORDER_INTENTS.has(intent)) return handleOrderFlow;
  if (FAMILY_REVIEW_INTENTS.has(intent)) return handleFamilyReview;
  return INTENT_HANDLERS[intent] ?? handleUnknown;
}

export async function handleWhatsAppInbound(input: WhatsAppInboundInput) {
  const session = await createWaSession(input);

  // Mid-checkout topic switch — don't drop the cart silently (UX-W4).
  if (!COOK_INTENTS.has(session.intent)) {
    const raw = (session.text || "").trim().toLowerCase();
    const isGuardReply = GUARD_CONTINUE.has(raw) || GUARD_CLEAR.has(raw);
    if (isGuardReply || !SESSION_SAFE.has(session.intent)) {
      const { getWaSession, clearWaSession } = await import("../services/waSession.js");
      const active = await getWaSession(session.db, session.mobile);
      // Only guard a cart with something in it — a bare kitchen list (PICK_KITCHEN) loses nothing.
      const inCheckout =
        active && (active.step === "PICK_ITEM" || active.step === "PICK_ADDRESS");
      if (inCheckout) {
        if (GUARD_CONTINUE.has(raw)) {
          return handleBrowse({ ...session, intent: "PICK" as const });
        }
        if (GUARD_CLEAR.has(raw)) {
          // The guard's own "Cancel order" button: drop the in-progress cart (not a placed order).
          await clearWaSession(session.db, session.mobile);
          await session.wa.send({
            to: session.from,
            body: session.wt("wa.checkoutCleared"),
            buttons: ["Menu", "Orders"],
          });
          return { ok: true, intent: "SESSION_CLEARED", replies: session.replies() };
        }
        await session.wa.send({
          to: session.from,
          body: session.wt("wa.sessionInProgress"),
          buttons: ["Continue", "Cancel order", "Help"],
        });
        return {
          ok: true,
          intent: "SESSION_GUARD",
          replies: session.replies(),
        };
      }
    }
  }

  const handler = resolveHandler(session.intent);
  return handler(session);
}
