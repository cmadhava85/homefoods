import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  extractInboundWhatsApp,
  isNonRetryableWhatsAppError,
  isWhatsAppConfigured,
  MetaWhatsAppProvider,
  MockWhatsAppProvider,
  parseCookMenuAdd,
  parseMenuCommand,
  parseOrderCommand,
  parseSaveAddressCommand,
  parseWeekCommand,
  parseWhatsAppIntent,
} from "./whatsapp.js";

describe("parseWhatsAppIntent", () => {
  it("maps Menu Order Pay Help", () => {
    assert.equal(parseWhatsAppIntent("Menu").intent, "MENU");
    assert.equal(parseWhatsAppIntent("show menu please").intent, "MENU");
    assert.equal(parseWhatsAppIntent("Order csk-homemade-delights").intent, "ORDER");
    assert.equal(parseWhatsAppIntent("order lunch amma-priya").intent, "ORDER");
    assert.equal(parseWhatsAppIntent("csk-homemade-delights").intent, "MENU");
    assert.equal(parseWhatsAppIntent("Pay").intent, "PAY");
    assert.equal(parseWhatsAppIntent("pay now").intent, "PAY");
    assert.equal(parseWhatsAppIntent("Late csk-homemade-delights").intent, "LATE");
    assert.equal(parseWhatsAppIntent("late order amma-priya 2").intent, "LATE");
    assert.equal(parseWhatsAppIntent("Late requests").intent, "COOK_LATE_LIST");
    assert.equal(parseWhatsAppIntent("Accept LM-1234").intent, "COOK_LATE_ACCEPT");
    assert.equal(parseWhatsAppIntent("Decline LM-1234").intent, "COOK_LATE_DECLINE");
    assert.equal(parseWhatsAppIntent("Pay LM-9999").intent, "PAY");
    assert.equal(parseWhatsAppIntent("Cancel").intent, "CANCEL");
    assert.equal(parseWhatsAppIntent("Cancel LM-1234").intent, "CANCEL");
    assert.equal(parseWhatsAppIntent("Orders").intent, "ORDERS");
    assert.equal(parseWhatsAppIntent("Week csk-homemade-delights").intent, "WEEK");
    assert.equal(parseWhatsAppIntent("Follow csk-homemade-delights").intent, "FOLLOW");
    assert.equal(parseWhatsAppIntent("Unfollow csk-homemade-delights").intent, "UNFOLLOW");
    assert.equal(parseWhatsAppIntent("Addresses").intent, "ADDRESSES");
    assert.equal(parseWhatsAppIntent("Save HOME Tower 1").intent, "SAVE_ADDRESS");
    assert.equal(parseWhatsAppIntent("Language Tamil").intent, "LANGUAGE");
    assert.equal(parseWhatsAppIntent("தமிழ்").intent, "LANGUAGE");
    assert.equal(parseWhatsAppIntent("1").intent, "PICK");
    assert.equal(parseWhatsAppIntent("Hi").intent, "MENU");
    assert.equal(parseWhatsAppIntent("Help").intent, "HELP");
    assert.equal(parseWhatsAppIntent("need help").intent, "HELP");
    assert.equal(parseWhatsAppIntent("hello").intent, "MENU");
    assert.equal(parseWhatsAppIntent("Family 9876543210").intent, "FAMILY");
    assert.equal(parseWhatsAppIntent("Accept family").intent, "FAMILY_ACCEPT");
    assert.equal(parseWhatsAppIntent("Review LM-1 5 great").intent, "REVIEW");
    assert.equal(parseWhatsAppIntent("Add Sambar rice 80").intent, "COOK_MENU_ADD");
    assert.equal(parseWhatsAppIntent("Post Chicken biryani 120 nonveg").intent, "COOK_MENU_ADD");
    assert.equal(parseWhatsAppIntent("Menu add Idli 40").intent, "COOK_MENU_ADD");
    assert.equal(parseWhatsAppIntent("My menu").intent, "COOK_MENU_LIST");
    assert.equal(parseWhatsAppIntent("Menu today").intent, "COOK_MENU_LIST");
    assert.equal(parseWhatsAppIntent("Skip").intent, "COOK_MENU_SKIP");
    assert.equal(parseWhatsAppIntent("Cancel requests").intent, "COOK_CANCEL_LIST");
  });
});

describe("parseCookMenuAdd", () => {
  it("reads name, price, and veg flag", () => {
    assert.deepEqual(parseCookMenuAdd("Add Sambar rice 80"), {
      itemName: "Sambar rice",
      priceRupees: 80,
      isVeg: true,
    });
    assert.deepEqual(parseCookMenuAdd("Post Chicken biryani 120 nonveg"), {
      itemName: "Chicken biryani",
      priceRupees: 120,
      isVeg: false,
    });
    assert.deepEqual(parseCookMenuAdd("Menu add Idli 40 veg"), {
      itemName: "Idli",
      priceRupees: 40,
      isVeg: true,
    });
    assert.deepEqual(parseCookMenuAdd("Add only name"), {});
    assert.deepEqual(parseCookMenuAdd("Order csk-homemade-delights"), {});
  });
});

describe("parseSaveAddressCommand", () => {
  it("reads label and line", () => {
    assert.deepEqual(parseSaveAddressCommand("Save HOME Tower 3, Flat 1204"), {
      label: "HOME",
      line1: "Tower 3, Flat 1204",
    });
    assert.deepEqual(parseSaveAddressCommand("Save address OFFICE: Tidel Park"), {
      label: "OFFICE",
      line1: "Tidel Park",
    });
    assert.deepEqual(parseSaveAddressCommand("Save"), {});
  });
});

describe("parseMenuCommand", () => {
  it("reads optional kitchen slug", () => {
    assert.deepEqual(parseMenuCommand("Menu"), { slug: undefined });
    assert.deepEqual(parseMenuCommand("Menu csk-homemade-delights"), { slug: "csk-homemade-delights" });
    assert.deepEqual(parseMenuCommand("csk-homemade-delights"), { slug: "csk-homemade-delights" });
  });
});

describe("parseOrderCommand", () => {
  it("reads slug and optional item index", () => {
    assert.deepEqual(parseOrderCommand("Order csk-homemade-delights"), {
      slug: "csk-homemade-delights",
      itemIndex: undefined,
      addressLabel: undefined,
      fulfillmentMode: undefined,
      payerMobile: undefined,
    });
    assert.deepEqual(parseOrderCommand("order lunch amma-priya 2"), {
      slug: "amma-priya",
      itemIndex: 2,
      addressLabel: undefined,
      fulfillmentMode: undefined,
      payerMobile: undefined,
    });
    assert.deepEqual(parseOrderCommand("Order csk-homemade-delights 1 HOME"), {
      slug: "csk-homemade-delights",
      itemIndex: 1,
      addressLabel: "HOME",
      fulfillmentMode: undefined,
      payerMobile: undefined,
    });
    assert.deepEqual(parseOrderCommand("Order csk-homemade-delights 1 PICKUP PAY 9876543210"), {
      slug: "csk-homemade-delights",
      itemIndex: 1,
      addressLabel: undefined,
      fulfillmentMode: "PICKUP",
      payerMobile: "9876543210",
    });
    assert.deepEqual(parseOrderCommand("Order csk-homemade-delights 1 HOME ARRANGE"), {
      slug: "csk-homemade-delights",
      itemIndex: 1,
      addressLabel: "HOME",
      fulfillmentMode: "CUSTOMER_ARRANGE",
      payerMobile: undefined,
    });
    assert.deepEqual(parseOrderCommand("csk-homemade-delights"), {});
  });
});

describe("parseWeekCommand", () => {
  it("reads meal type for advance / week carts", () => {
    assert.deepEqual(parseWeekCommand("Week csk-homemade-delights"), { slug: "csk-homemade-delights" });
    assert.deepEqual(parseWeekCommand("Week csk-homemade-delights lunch"), {
      slug: "csk-homemade-delights",
      mealType: "LUNCH",
      addressLabel: undefined,
      fulfillmentMode: undefined,
      payerMobile: undefined,
    });
    assert.deepEqual(parseWeekCommand("Week csk-homemade-delights L all"), {
      slug: "csk-homemade-delights",
      mealType: "LUNCH",
      addressLabel: undefined,
      fulfillmentMode: undefined,
      payerMobile: undefined,
      all: true,
      itemIndex: 1,
    });
    assert.deepEqual(parseWeekCommand("Week csk-homemade-delights dinner Mon Wed"), {
      slug: "csk-homemade-delights",
      mealType: "DINNER",
      addressLabel: undefined,
      fulfillmentMode: undefined,
      payerMobile: undefined,
      dayTokens: ["mon", "wed"],
      itemIndex: 1,
    });
    assert.deepEqual(parseWeekCommand("Week csk-homemade-delights L all HOME"), {
      slug: "csk-homemade-delights",
      mealType: "LUNCH",
      addressLabel: "HOME",
      fulfillmentMode: undefined,
      payerMobile: undefined,
      all: true,
      itemIndex: 1,
    });
    assert.deepEqual(parseWeekCommand("Week csk-homemade-delights L all HOME ARRANGE"), {
      slug: "csk-homemade-delights",
      mealType: "LUNCH",
      addressLabel: "HOME",
      fulfillmentMode: "CUSTOMER_ARRANGE",
      payerMobile: undefined,
      all: true,
      itemIndex: 1,
    });
    assert.deepEqual(parseWeekCommand("Week csk-homemade-delights L all PICKUP"), {
      slug: "csk-homemade-delights",
      mealType: "LUNCH",
      addressLabel: undefined,
      fulfillmentMode: "PICKUP",
      payerMobile: undefined,
      all: true,
      itemIndex: 1,
    });
  });
});

describe("MockWhatsAppProvider", () => {
  it("records outbound and verifies token", async () => {
    const wa = new MockWhatsAppProvider();
    const sent = await wa.send({ to: "+9198", body: "hi", buttons: ["Ok"] });
    assert.match(sent.messageId, /^wa_mock_/);
    assert.equal(wa.sent.length, 1);
    assert.equal(wa.sent[0].to, "+9198");

    process.env.WHATSAPP_VERIFY_TOKEN = "localmeals-dev";
    assert.equal(wa.verifyWebhook({ "hub.verify_token": "localmeals-dev" }), true);
    assert.equal(wa.verifyWebhook({ "hub.verify_token": "wrong" }), false);
  });
});

describe("extractInboundWhatsApp", () => {
  it("reads simulator and Meta button taps", () => {
    assert.deepEqual(extractInboundWhatsApp({ from: "+9198", text: "Menu" }), {
      from: "+9198",
      text: "Menu",
    });
    const meta = extractInboundWhatsApp({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "919840111111",
                    type: "interactive",
                    interactive: { button_reply: { title: "Orders", id: "btn_0" } },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    assert.equal(meta.from, "+919840111111");
    assert.equal(meta.text, "Orders");
  });

  it("reads mock image and Meta image media id", () => {
    assert.deepEqual(
      extractInboundWhatsApp({
        from: "+919876543211",
        imageUrl: "/uploads/menu-x.jpg",
      }),
      {
        from: "+919876543211",
        text: undefined,
        image: { imageUrl: "/uploads/menu-x.jpg", imageBase64: undefined, mimeType: "image/jpeg" },
      },
    );
    const metaImg = extractInboundWhatsApp({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "919876543211",
                    type: "image",
                    image: { id: "media_123", mime_type: "image/jpeg", caption: "plate" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    assert.equal(metaImg.from, "+919876543211");
    assert.equal(metaImg.text, "plate");
    assert.equal(metaImg.image?.mediaId, "media_123");
  });
});

describe("MetaWhatsAppProvider", () => {
  it("verifies X-Hub-Signature-256", () => {
    process.env.WHATSAPP_APP_SECRET = "app_secret";
    const wa = new MetaWhatsAppProvider();
    const raw = '{"object":"whatsapp_business_account"}';
    const hex = createHmac("sha256", "app_secret").update(raw).digest("hex");
    assert.equal(
      wa.verifyIncomingSignature({ "x-hub-signature-256": `sha256=${hex}` }, raw),
      true,
    );
    assert.equal(
      wa.verifyIncomingSignature({ "x-hub-signature-256": "sha256=deadbeef" }, raw),
      false,
    );
  });
});

describe("isWhatsAppConfigured", () => {
  it("rejects REPLACE_ME placeholders", () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "REPLACE_ME";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "REPLACE_ME";
    process.env.WHATSAPP_VERIFY_TOKEN = "REPLACE_ME";
    process.env.WHATSAPP_APP_SECRET = "REPLACE_ME";
    assert.equal(isWhatsAppConfigured(), false);

    process.env.WHATSAPP_ACCESS_TOKEN = "EAAB…";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "123456";
    process.env.WHATSAPP_VERIFY_TOKEN = "localmeals-verify";
    process.env.WHATSAPP_APP_SECRET = "appsec";
    assert.equal(isWhatsAppConfigured(), true);
  });
});

describe("isNonRetryableWhatsAppError", () => {
  it("detects Meta allowlist / undeliverable codes", () => {
    assert.equal(
      isNonRetryableWhatsAppError(
        new Error("(#131030) Recipient phone number not in allowed list"),
      ),
      true,
    );
    assert.equal(isNonRetryableWhatsAppError(new Error("(#131047) re-engagement")), true);
    assert.equal(isNonRetryableWhatsAppError(new Error("timeout")), false);
  });
});
