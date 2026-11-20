/**
 * End-to-end WhatsApp bot conversation (mock Meta Cloud API).
 *
 * Covers the customer lunch path over /webhooks/whatsapp plus a few cook
 * intents. Unit intent parsing lives in packages/adapters; live Graph smoke
 * is scripts/smoke-whatsapp.mjs.
 *
 *   node --import tsx --test src/whatsappBot.e2e.test.ts
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getWhatsAppProvider,
  isMockWhatsApp,
  resetWhatsAppProvider,
} from "@localmeals/adapters";
import { sql } from "drizzle-orm";
import { closeDb, createDb } from "@localmeals/db";
import { buildApp } from "./app.js";
import { loginCook, testMobile } from "./testHelpers.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";
// Force known verify token for this suite (dotenv may have a live Meta token).
process.env.WHATSAPP_VERIFY_TOKEN = "localmeals-dev";
resetWhatsAppProvider();

type WaReply = { body?: string };
type WaResult = {
  ok?: boolean;
  intent?: string;
  publicId?: string;
  ticketId?: number;
  addressId?: number;
  replies?: WaReply[];
  error?: string;
  ignored?: boolean;
};

describe("WhatsApp bot e2e", () => {
  const db = createDb();
  const app = buildApp(db);
  let cookHeaders: { authorization: string };

  async function wa(from: string, text: string, extra?: Record<string, unknown>): Promise<WaResult> {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: { from, text, ...extra },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as WaResult;
  }

  function replyBody(r: WaResult): string {
    const body = r.replies?.[0]?.body ?? "";
    assert.ok(body.length > 0, `expected reply body, got ${JSON.stringify(r)}`);
    return body;
  }

  before(async () => {
    await app.ready();
    // OTP rate limits are Postgres-backed and persist across test runs.
    await db.execute(sql`DELETE FROM rate_limit_buckets`);
    cookHeaders = (await loginCook(app, "csk-homemade-delights")).headers;
    const cut = await app.inject({
      method: "PATCH",
      url: "/cooks/csk-homemade-delights/meal-settings/LUNCH",
      headers: cookHeaders,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    assert.equal(cut.statusCode, 200, cut.body);
    const menu = await app.inject({ method: "GET", url: "/kitchens/csk-homemade-delights/menu" });
    assert.ok(menu.json().menus?.[0], "No menu for csk-homemade-delights — run npm run db:seed");
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("webhook verify challenge", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=localmeals-dev&hub.challenge=e2e-challenge",
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "e2e-challenge");
  });

  it("rejects bad verify token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x",
    });
    assert.equal(res.statusCode, 403);
  });

  it("customer journey: Hi → Save → Menu → pick → Pay → Orders → Cancel", async () => {
    const from = testMobile("71");
    const mock = getWhatsAppProvider();
    assert.ok(isMockWhatsApp(mock));
    const sentBefore = mock.sent.length;

    const hi = await wa(from, "Hi");
    assert.equal(hi.intent, "MENU");
    assert.match(replyBody(hi), /csk-homemade-delights|kitchen|Menu|Reply/i);

    const save = await wa(from, "Save HOME WA Bot E2E Tower 1, Flat 101");
    assert.equal(save.intent, "SAVE_ADDRESS");
    assert.ok(save.addressId);
    assert.match(replyBody(save), /Saved HOME/i);

    const addresses = await wa(from, "Addresses");
    assert.equal(addresses.intent, "ADDRESSES");
    assert.match(replyBody(addresses), /HOME|WA Bot E2E Tower 1/i);

    const kitchenMenu = await wa(from, "Menu csk-homemade-delights");
    assert.equal(kitchenMenu.intent, "MENU");
    assert.match(replyBody(kitchenMenu), /Reply 1|tap below|1\./i);

    const pick = await wa(from, "1");
    assert.ok(["ORDER", "LATE", "PICK"].includes(pick.intent ?? ""), pick.intent);
    assert.ok(pick.publicId || pick.error !== "no_address", JSON.stringify(pick));
    if (!pick.publicId) {
      // Late window or empty menu edge — fall back to explicit Order slug
      const order = await wa(from, "Order csk-homemade-delights 1 HOME");
      assert.equal(order.intent, "ORDER", JSON.stringify(order));
      assert.ok(order.publicId, JSON.stringify(order));
      Object.assign(pick, order);
    }
    assert.ok(pick.publicId);
    assert.match(replyBody(pick), /Pay |Late request/i);

    const pay = await wa(from, "Pay");
    assert.equal(pay.intent, "PAY");
    assert.equal(pay.publicId, pick.publicId);
    assert.match(replyBody(pay), /Pay |http|plink_|mock/i);

    const orders = await wa(from, "Orders");
    assert.equal(orders.intent, "ORDERS");
    assert.match(replyBody(orders), new RegExp(pick.publicId!, "i"));

    const cancel = await wa(from, `Cancel ${pick.publicId}`);
    assert.equal(cancel.intent, "CANCEL");
    assert.match(replyBody(cancel), /cancel|request|Cancel/i);

    assert.ok(
      mock.sent.length > sentBefore,
      "MockWhatsAppProvider should record outbound replies",
    );
  });

  it("guided Order slug without prior digit pick", async () => {
    const from = testMobile("72");
    await wa(from, "Save HOME Bot Order Tower 2");
    const order = await wa(from, "Order csk-homemade-delights 1 HOME");
    assert.equal(order.intent, "ORDER", JSON.stringify(order));
    assert.ok(order.publicId, JSON.stringify(order));
    assert.match(replyBody(order), /Deliver to HOME|Pay /i);
  });

  it("Follow / Unfollow kitchen", async () => {
    const from = testMobile("73");
    const follow = await wa(from, "Follow csk-homemade-delights");
    assert.equal(follow.intent, "FOLLOW");
    assert.match(replyBody(follow), /follow|csk-homemade-delights|kitchen/i);

    const unfollow = await wa(from, "Unfollow csk-homemade-delights");
    assert.equal(unfollow.intent, "UNFOLLOW");
    assert.match(replyBody(unfollow), /unfollow|removed|csk-homemade-delights|ok/i);
  });

  it("Language Tamil then Menu still replies", async () => {
    const from = testMobile("74");
    const lang = await wa(from, "Language Tamil");
    assert.equal(lang.intent, "LANGUAGE");
    const menu = await wa(from, "Menu");
    assert.equal(menu.intent, "MENU");
    assert.ok(replyBody(menu).length > 10);
  });

  it("Help opens a support ticket", async () => {
    const from = testMobile("75");
    const help = await wa(from, "Help lunch never arrived");
    assert.equal(help.intent, "HELP");
    assert.ok(help.ticketId);
    assert.match(replyBody(help), /ticket|help|support|team/i);
  });

  it("Meta Cloud API envelope is accepted", async () => {
    const fromDigits = testMobile("76").replace(/\D/g, "");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: {
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: fromDigits,
                      type: "text",
                      text: { body: "Menu" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as WaResult;
    assert.equal(body.intent, "MENU");
    assert.ok(replyBody(body).length > 0);
  });

  it("ignores empty Meta status-only webhook", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      payload: {
        object: "whatsapp_business_account",
        entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
      },
    });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as WaResult).ignored, true);
  });

  it("cook My menu lists plates", async () => {
    const cookMobile = "+919876543210";
    const list = await wa(cookMobile, "My menu");
    assert.equal(list.intent, "COOK_MENU_LIST");
    assert.ok(replyBody(list).length > 5);
  });
});
