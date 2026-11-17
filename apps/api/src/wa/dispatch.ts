import type { WhatsAppInboundInput } from "./session.js";
import { createWaSession } from "./session.js";
import { handleLanguage } from "./handlers/language.js";
import { handleCookOps } from "./handlers/cookOps.js";
import { handleBrowse } from "./handlers/browse.js";
import { handleHelp } from "./handlers/help.js";
import { handleOrderFlow } from "./handlers/orderFlow.js";
import { handlePay } from "./handlers/pay.js";
import { handleFamilyReview } from "./handlers/familyReview.js";
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

const BROWSE_INTENTS = new Set(["PICK", "MENU", "ADDRESSES", "SAVE_ADDRESS"]);

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

/** Intent registry — add new WhatsApp intents here (OCP). */
const INTENT_HANDLERS: Record<string, WaHandler> = {
  LANGUAGE: handleLanguage,
  HELP: handleHelp,
  PAY: handlePay,
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
  const handler = resolveHandler(session.intent);
  return handler(session);
}
