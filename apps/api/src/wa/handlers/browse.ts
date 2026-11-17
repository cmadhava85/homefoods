import {
  parseMenuCommand,
  parsePickNumber,
  parseSaveAddressCommand,
} from "@localmeals/adapters";
import { getKitchenMenu, listKitchens } from "../../services/orders.js";
import { publicErrorMessage } from "../../httpErrors.js";
import { localizedDishName, type Locale } from "@localmeals/i18n";
import type { WaSession } from "../session.js";

export async function handleBrowse(s: WaSession): Promise<object> {
  const {
    db, from, text, intent, wa, mobile, replies, waSafe, wt,
    customerServicePin, resolveWaDeliveryAddress, sendKitchenMenuWa, placeOrRequestLunch,
    ensureCustomerUser, clearWaSession, getWaSession, setWaSession,
  } = s;
  let { waLocale } = { waLocale: s.waLocale };
  const setLocale = (v: Locale) => { s.waLocale = v; waLocale = v; };

  if (intent === "PICK") {
    return await waSafe("PICK", async () => {
      const n = parsePickNumber(text);
      const session = await getWaSession(db, mobile);
      if (n == null || !session) {
        await wa.send({
          to: from,
          body: wt("wa.startWithMenu"),
          buttons: ["Menu"],
        });
        return { ok: true, intent, error: "no_session", replies: replies() };
      }

      if (session.step === "PICK_KITCHEN") {
        const kitchen = session.payload.kitchens?.find((k) => k.n === n);
        if (!kitchen) {
          await wa.send({
            to: from,
            body: wt("wa.pickKitchenRange", { max: session.payload.kitchens?.length ?? 0 }),
            buttons: ["Menu"],
          });
          return { ok: true, intent, error: "bad_pick", replies: replies() };
        }
        return sendKitchenMenuWa(kitchen.slug);
      }

      if (session.step === "PICK_ITEM") {
        const item = session.payload.items?.find((i) => i.n === n);
        const slug = session.payload.cookSlug;
        if (!item || !slug) {
          await wa.send({
            to: from,
            body: wt("wa.itemNotOnList"),
            buttons: ["Menu"],
          });
          return { ok: true, intent, error: "bad_pick", replies: replies() };
        }
        return placeOrRequestLunch({
          intent: session.payload.forceLate ? "LATE" : "ORDER",
          slug,
          itemIndex: n,
          forceLate: Boolean(session.payload.forceLate),
          fulfillmentMode: session.payload.fulfillmentMode === "PICKUP" ? "PICKUP" : "DELIVERY",
          payerMobile: session.payload.payerMobile ?? null,
        });
      }

      if (session.step === "PICK_ADDRESS") {
        const list = (await import("../../services/addresses.js")).listAddressesForMobile;
        const addresses = await list(db, mobile);
        const chosen = addresses[n - 1];
        const slug = session.payload.cookSlug;
        const itemIndex = session.payload.itemIndex ?? 1;
        if (!chosen || !slug) {
          await wa.send({
            to: from,
            body: wt("wa.pickAddressNumber"),
            buttons: ["Addresses", "Menu"],
          });
          return { ok: true, intent, error: "bad_pick", replies: replies() };
        }
        return placeOrRequestLunch({
          intent: session.payload.forceLate ? "LATE" : "ORDER",
          slug,
          itemIndex,
          addressLabel: chosen.label as "HOME" | "OFFICE" | "OTHER",
          forceLate: Boolean(session.payload.forceLate),
          fulfillmentMode: session.payload.fulfillmentMode === "PICKUP" ? "PICKUP" : "DELIVERY",
          payerMobile: session.payload.payerMobile ?? null,
        });
      }

      await wa.send({
        to: from,
        body: wt("wa.sessionExpired"),
        buttons: ["Menu"],
      });
      await clearWaSession(db, mobile);
      return { ok: true, intent, error: "expired", replies: replies() };
    });
  }

  if (intent === "MENU") {
    return await waSafe("MENU", async () => {
      const { slug } = parseMenuCommand(text);
      if (slug) {
        return sendKitchenMenuWa(slug);
      }

      const kitchens = await listKitchens(db, await customerServicePin());
      if (!kitchens.length) {
        await wa.send({
          to: from,
          body: wt("wa.noLiveKitchens"),
          buttons: ["Help"],
        });
        return { ok: true, intent, empty: true, replies: replies() };
      }

      // One kitchen nearby → skip straight to plates (fewer taps)
      if (kitchens.length === 1) {
        return sendKitchenMenuWa(kitchens[0].slugHandle);
      }

      const kitchenOpts = kitchens.slice(0, 5).map((k, i) => ({
        n: i + 1,
        slug: k.slugHandle,
        name: k.kitchenName,
      }));
      await setWaSession(db, mobile, "PICK_KITCHEN", { kitchens: kitchenOpts });

      const blocks: string[] = [
        wt("wa.kitchensNearYou"),
        wt("wa.replyNumberOrTap"),
        "",
      ];
      for (const k of kitchenOpts) {
        const menu = await getKitchenMenu(db, k.slug);
        const plate = menu?.menus?.[0];
        blocks.push(
          `${k.n}. *${k.name}*${plate ? ` — ${localizedDishName(waLocale, plate)} ₹${(plate.pricePaise / 100).toFixed(0)}` : wt("wa.noPlateYet")}`,
        );
      }
      blocks.push("", wt("wa.thenPickDish"));
      await wa.send({
        to: from,
        body: blocks.join("\n"),
        buttons: kitchenOpts.slice(0, 3).map((k) => k.slug),
      });
      return { ok: true, intent, replies: replies() };
    });
  }

  if (intent === "ADDRESSES") {
    return await waSafe("ADDRESSES", async () => {

    const { listAddressesForMobile } = await import("../../services/addresses.js");
    const list = await listAddressesForMobile(db, mobile);
    if (!list.length) {
      await wa.send({
        to: from,
        body: wt("wa.noAddresses"),
        buttons: ["Menu", "Help"],
      });
      return { ok: true, intent, empty: true, replies: replies() };
    }
    await wa.send({
      to: from,
      body: [
        wt("wa.addressesTitle"),
        ...list.map((a) => `• ${a.label} — ${a.line1} · ${a.pinCode}`),
        "",
        wt("wa.orderWithLabel"),
      ].join("\n"),
      buttons: ["Menu", `Order sri-sai 1 ${list[0].label}`, "Help"],
    });
    return { ok: true, intent, replies: replies() };
        });
  }

  if (intent === "SAVE_ADDRESS") {
    const parsed = parseSaveAddressCommand(text);
    if (!parsed.label || !parsed.line1) {
      await wa.send({
        to: from,
        body: "Format: Save HOME <full address>\nExample: Save HOME Tower 3, Flat 1204, OMR",
        buttons: ["Addresses", "Menu"],
      });
      return { ok: true, intent, error: "bad_format", replies: replies() };
    }
    try {
      const pin = await customerServicePin();
      const { createAddress } = await import("../../services/addresses.js");
      const row = await createAddress(db, {
        mobile,
        label: parsed.label,
        line1: parsed.line1,
        pinCode: pin,
        isDefault: parsed.label === "HOME",
      });
      const pending = await getWaSession(db, mobile);
      if (
        pending?.step === "AWAIT_ADDRESS" &&
        pending.payload.cookSlug &&
        pending.payload.itemIndex
      ) {
        return placeOrRequestLunch({
          intent: pending.payload.forceLate ? "LATE" : "ORDER",
          slug: pending.payload.cookSlug,
          itemIndex: pending.payload.itemIndex,
          addressLabel: row.label as "HOME" | "OFFICE" | "OTHER",
          forceLate: Boolean(pending.payload.forceLate),
        });
      }
      await wa.send({
        to: from,
        body: `Saved ${row.label}: ${row.line1}\n\nTap Menu to pick a kitchen — we’ll use this address.`,
        buttons: ["Menu", "Addresses"],
      });
      return { ok: true, intent, addressId: row.id, replies: replies() };
    } catch (e) {
      await wa.send({
        to: from,
        body: publicErrorMessage(e, waLocale),
        buttons: ["Addresses", "Menu"],
      });
      return { ok: true, intent, error: publicErrorMessage(e, waLocale), replies: replies() };
    }
  }

  return { ok: true, intent, unhandled: true as const, replies: replies() };
}
