#!/usr/bin/env node
/**
 * Local WhatsApp / Meta Cloud API smoke test.
 *
 * Usage:
 *   node scripts/smoke-whatsapp.mjs
 *   WHATSAPP_SMOKE_TO=9198XXXXXXXX node scripts/smoke-whatsapp.mjs
 *
 * Requires real WHATSAPP_* in .env (not REPLACE_ME). Keeps MOCK_WHATSAPP=true
 * for the rest of the app; this script forces Meta for the check only.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Do not override vars already set in the shell (e.g. token from Secret Manager).
config({ path: resolve(root, ".env"), override: false });

process.env.MOCK_WHATSAPP = "false";

const {
  MetaWhatsAppProvider,
  isWhatsAppConfigured,
  resetWhatsAppProvider,
} = await import("../packages/adapters/dist/whatsapp.js");

resetWhatsAppProvider();

const results = [];
function ok(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

ok("credentials configured", isWhatsAppConfigured(), "set WHATSAPP_* in .env / Secret Manager");

if (!isWhatsAppConfigured()) {
  console.log(`
WhatsApp secrets are missing or still REPLACE_ME.

1. Meta Business → WhatsApp → API Setup
2. Copy Phone number ID, Access token, App secret
3. Pick a verify string (e.g. openssl rand -hex 16)
4. Store in Secret Manager + .env:
   WHATSAPP_PHONE_NUMBER_ID
   WHATSAPP_ACCESS_TOKEN
   WHATSAPP_APP_SECRET
   WHATSAPP_VERIFY_TOKEN
5. Webhook (needs public HTTPS): https://YOUR_API/webhooks/whatsapp
   Subscribe: messages
6. Re-run this script
`);
  process.exit(1);
}

const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const token = process.env.WHATSAPP_ACCESS_TOKEN;
const apiVersion = process.env.WHATSAPP_API_VERSION ?? "v21.0";

try {
  const res = await fetch(
    `https://graph.facebook.com/${apiVersion}/${phoneId}?fields=display_phone_number,verified_name,quality_rating`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  ok(
    "Graph phone lookup",
    res.ok && !json.error,
    res.ok
      ? `${json.display_phone_number ?? phoneId} · ${json.verified_name ?? ""}`
      : json.error?.message ?? `HTTP ${res.status}`,
  );
} catch (e) {
  ok("Graph phone lookup", false, e instanceof Error ? e.message : String(e));
}

const raw = JSON.stringify({ object: "whatsapp_business_account" });
const hex = createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(raw).digest("hex");
const wa = new MetaWhatsAppProvider();
ok(
  "app secret HMAC",
  wa.verifyIncomingSignature({ "x-hub-signature-256": `sha256=${hex}` }, raw) === true,
);
ok(
  "verify token match",
  wa.verifyWebhook({
    "hub.mode": "subscribe",
    "hub.verify_token": process.env.WHATSAPP_VERIFY_TOKEN,
  }) === true,
);

const to = process.env.WHATSAPP_SMOKE_TO?.replace(/\D/g, "");
if (to && to.length >= 10) {
  try {
    const sent = await wa.send({
      to,
      body: "LocalMeals WhatsApp smoke test — reply Menu",
      buttons: ["Menu", "Help"],
    });
    ok("send smoke message", !!sent.messageId, sent.messageId);
  } catch (e) {
    ok("send smoke message", false, e instanceof Error ? e.message : String(e));
  }
} else {
  console.log("SKIP  send smoke message — set WHATSAPP_SMOKE_TO=91XXXXXXXXXX to test outbound");
}

const failed = results.filter((r) => !r.pass);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
