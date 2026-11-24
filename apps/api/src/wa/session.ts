import type { Db } from "@localmeals/db";
import {
  getWhatsAppProvider,
  isMockWhatsApp,
  parseWhatsAppIntent,
} from "@localmeals/adapters";
import {
  createOrder,
  getKitchenMenu,
  getKitchenWeekPlan,
  requestLateOrder,
} from "../services/orders.js";
import { publicErrorMessage } from "../httpErrors.js";
import {
  DEFAULT_LOCALE,
  localizedDishName,
  localizedMealPeriod,
  localizedWeekday,
  t as i18nT,
  type Locale,
  type MsgKey,
} from "@localmeals/i18n";

export type WhatsAppInboundInput = {
  db: Db;
  from: string;
  text: string;
  image?: {
    mediaId?: string;
    mimeType?: string;
    imageUrl?: string;
    imageBase64?: string;
  };
  localeHint?: string | null;
};

export type WaSession = Awaited<ReturnType<typeof createWaSession>>;

export async function createWaSession(input: WhatsAppInboundInput) {
  const { db, from, text, image } = input;
  const { intent: textIntent } = parseWhatsAppIntent(text || " ");
  const intent = image ? ("COOK_MENU_PHOTO" as const) : textIntent;
  const wa = getWhatsAppProvider();
  const sentBefore = isMockWhatsApp(wa) ? wa.sent.length : 0;
  const replies = () =>
    isMockWhatsApp(wa) ? wa.sent.slice(sentBefore).map((m) => ({ body: m.body, buttons: m.buttons })) : [];
  const mobile = from.startsWith("+") ? from : `+${from}`;

  const { ensureCustomerUser, getCustomerPreferredLocale, getCustomerProfile } =
    await import("../services/profile.js");
  const { clearWaSession, getWaSession, setWaSession } = await import("../services/waSession.js");
  const hint =
    input.localeHint === "en" || input.localeHint === "ta"
      ? input.localeHint
      : null;
  // Simulator localeHint wins so site EN/தமிழ் matches chat; Meta has no hint → profile.
  let waLocale: Locale =
    hint ?? (await getCustomerPreferredLocale(db, mobile)) ?? DEFAULT_LOCALE;

  function wt(key: MsgKey, params?: Record<string, string | number>) {
    return i18nT(waLocale, key, params);
  }

  async function waSafe(
    intentName: string,
    run: () => Promise<object>,
    buttons: string[] = ["Menu", "Help"],
  ): Promise<object> {
    try {
      return await run();
    } catch (e) {
      const msg = publicErrorMessage(e, waLocale);
      await wa.send({ to: from, body: msg, buttons });
      return { ok: true, intent: intentName, error: msg, replies: replies() };
    }
  }

  async function customerServicePin() {
    try {
      return (await getCustomerProfile(db, mobile)).pinCode || "600119";
    } catch {
      return "600119";
    }
  }

  async function resolveWaDeliveryAddress(label?: "HOME" | "OFFICE" | "OTHER") {
    const { listAddressesForMobile, getAddressByLabel } = await import("../services/addresses.js");
    const all = await listAddressesForMobile(db, mobile);
    // Ignore signup placeholders so WA never delivers to "Address on file".
    const list = all.filter((a) => {
      const line = (a.line1 ?? "").trim();
      return line.length > 0 && !/^address on file/i.test(line);
    });
    if (!list.length) {
      return { kind: "empty" as const, list };
    }
    // Fast path: omit label → default / HOME / sole address (fewer WhatsApp taps)
    if (!label) {
      const preferred =
        list.find((a) => a.isDefault) ??
        list.find((a) => a.label === "HOME") ??
        (list.length === 1 ? list[0] : undefined);
      if (preferred) {
        return {
          kind: "ok" as const,
          list,
          addressId: preferred.id,
          label: preferred.label as "HOME" | "OFFICE" | "OTHER",
        };
      }
      return { kind: "need_label" as const, list };
    }
    try {
      const row = await getAddressByLabel(db, mobile, label);
      const line = (row.line1 ?? "").trim();
      if (!line || /^address on file/i.test(line)) {
        return {
          kind: "missing_label" as const,
          list,
          error: "Save a real address first (Address Tower/flat PIN 600119)",
        };
      }
      return { kind: "ok" as const, list, addressId: row.id, label };
    } catch (e) {
      return { kind: "missing_label" as const, list, error: (e as Error).message };
    }
  }

  async function sendKitchenMenuWa(slug: string) {
    const menu = await getKitchenMenu(db, slug);
    if (!menu) {
      await wa.send({
        to: from,
        body: wt("wa.kitchenNotFound", { slug }),
        buttons: ["Menu"],
      });
      return { ok: true as const, intent: "MENU" as const, error: "kitchen_not_found", replies: replies() };
    }
    if (menu.mealEnabled === false) {
      await wa.send({
        to: from,
        body: wt("wa.mealNotOffered", {
          kitchen: menu.cook.kitchenName,
          meal: menu.mealLabel ?? "lunch",
        }),
        buttons: ["Menu"],
      });
      return { ok: true as const, intent: "MENU" as const, error: "meal_disabled", replies: replies() };
    }
    const mealType = menu.mealType ?? "LUNCH";
    const mealCmd =
      mealType === "BREAKFAST" ? "B" : mealType === "DINNER" ? "D" : "L";
    const mealLabel = localizedMealPeriod(waLocale, mealType);
    const week = await getKitchenWeekPlan(db, slug, { days: 7, mealType });
    const upcoming = (week?.plan ?? []).filter(
      (d) => !d.isToday && d.menus.length > 0,
    );
    const openUpcoming = upcoming.filter((d) => d.orderingOpen);
    const daysToShow = (openUpcoming.length ? openUpcoming : upcoming).slice(0, 5);
    const upcomingLines = daysToShow.map((d) => {
      const first = d.menus[0];
      const name = first ? localizedDishName(waLocale, first) : "plate";
      const price = first ? ` ₹${(first.pricePaise / 100).toFixed(0)}` : "";
      const extra = d.menus.length > 1 ? ` (+${d.menus.length - 1})` : "";
      const day = localizedWeekday(waLocale, d.dayOfWeek);
      return `• ${day} ${d.serviceDate.slice(5)} — ${name}${price}${extra}`;
    });

    if (!menu.menus.length) {
      if (daysToShow.length) {
        await wa.send({
          to: from,
          body: [
            wt("wa.kitchenHeader", { kitchen: menu.cook.kitchenName }),
            wt("wa.todayNoPlates", { meal: mealLabel }),
            "",
            wt("wa.upcomingHeader"),
            ...upcomingLines,
            "",
            wt("wa.weekBookDays", { slug, mealCmd }),
          ].join("\n"),
          buttons: [`Week ${slug} ${mealCmd}`, "Menu"],
        });
        return {
          ok: true as const,
          intent: "MENU" as const,
          emptyToday: true,
          upcomingDays: daysToShow.length,
          replies: replies(),
        };
      }

      await wa.send({
        to: from,
        body: wt("wa.noPlatesWeek", {
          kitchen: menu.cook.kitchenName,
          meal: mealLabel,
        }),
        buttons: ["Menu"],
      });
      return { ok: true as const, intent: "MENU" as const, error: "no_menu", replies: replies() };
    }

    const forceLate = menu.orderingOpen === false;
    await setWaSession(db, mobile, "PICK_ITEM", {
      cookSlug: slug,
      kitchenName: menu.cook.kitchenName,
      forceLate,
      items: menu.menus.map((m, i) => ({
        n: i + 1,
        menuItemId: m.id,
        name: localizedDishName(waLocale, m),
        pricePaise: m.pricePaise,
      })),
    });

    const todayLines = menu.menus.map(
      (m, i) =>
        `${i + 1}. ${localizedDishName(waLocale, m)} — ₹${(m.pricePaise / 100).toFixed(0)}${m.isVeg ? " · veg" : ""}`,
    );
    const orderBtns = menu.menus.slice(0, 2).map((_, i) =>
      forceLate ? `Late ${slug} ${i + 1}` : `Order ${slug} ${i + 1}`,
    );
    const body = [
      wt("wa.kitchenHeader", { kitchen: menu.cook.kitchenName }),
      wt("wa.mealCutoffLine", {
        meal: mealLabel,
        cutoff: menu.cutoff ?? menu.lunchCutoff ?? "08:00",
        late: forceLate ? wt("wa.lateSuffix") : "",
      }),
      wt("wa.deliveryLine", { window: menu.deliveryWindow ?? "12:00–13:00" }),
      "",
      wt("wa.todayHeader"),
      ...todayLines,
    ];
    if (upcomingLines.length) {
      body.push("", wt("wa.upcomingHeader"), ...upcomingLines);
    }
    body.push(
      "",
      forceLate
        ? wt("wa.lateOrderHint")
        : wt("wa.todayOrderHint", { slug, mealCmd }),
    );
    await wa.send({
      to: from,
      body: body.join("\n"),
      buttons: [...orderBtns, `Week ${slug} ${mealCmd}`, "Menu"].slice(0, 3),
    });
    return {
      ok: true as const,
      intent: "MENU" as const,
      slug,
      upcomingDays: daysToShow.length,
      replies: replies(),
    };
  }

  async function placeOrRequestLunch(opts: {
    intent: "ORDER" | "LATE";
    slug: string;
    itemIndex?: number;
    addressLabel?: "HOME" | "OFFICE" | "OTHER";
    fulfillmentMode?: "DELIVERY" | "PICKUP" | "CUSTOMER_ARRANGE";
    payerMobile?: string | null;
    forceLate: boolean;
  }) {
    const {
      slug,
      itemIndex,
      addressLabel,
      forceLate,
      intent: placeIntent,
      fulfillmentMode: wantFulfillment = "DELIVERY",
      payerMobile = null,
    } = opts;
    const { normalizeFulfillmentMode, needsCheckoutAddress } = await import("@localmeals/domain");
    const fulfillmentMode = normalizeFulfillmentMode(wantFulfillment);
    const menu = await getKitchenMenu(db, slug);
    if (!menu?.menus?.length) {
      await wa.send({
        to: from,
        body: `No menu for ${slug} today. Ask the cook to post today’s plates, or try Menu.`,
        buttons: ["Menu"],
      });
      return { ok: true, intent: placeIntent, error: "no_menu", replies: replies() };
    }
    const idx = itemIndex != null ? itemIndex - 1 : 0;
    const item = menu.menus[idx] ?? menu.menus[0];
    if (itemIndex != null && !menu.menus[idx]) {
      const prefix = forceLate || menu.orderingOpen === false ? "Late" : "Order";
      await wa.send({
        to: from,
        body: [
          `Pick a number for ${menu.cook.kitchenName}:`,
          ...menu.menus.map(
            (m, i) =>
              `${i + 1}. ${localizedDishName(waLocale, m)} · ₹${(m.pricePaise / 100).toFixed(0)}`,
          ),
          "",
          `Reply: ${prefix} ${slug} 1 HOME`,
        ].join("\n"),
        buttons: menu.menus.slice(0, 3).map((_, i) => `${prefix} ${slug} ${i + 1}`),
      });
      return { ok: true, intent: placeIntent, needItem: true, replies: replies() };
    }

    const useLate = forceLate || menu.orderingOpen === false;
    const n = itemIndex ?? 1;

    let addressId: number | null = null;
    let addressLabelResolved: string =
      fulfillmentMode === "PICKUP"
        ? "PICKUP"
        : fulfillmentMode === "CUSTOMER_ARRANGE"
          ? "ARRANGE"
          : "HOME";
    if (needsCheckoutAddress(fulfillmentMode)) {
      const addr = await resolveWaDeliveryAddress(addressLabel);
      if (addr.kind === "empty") {
        await setWaSession(db, mobile, "AWAIT_ADDRESS", {
          cookSlug: slug,
          kitchenName: menu.cook.kitchenName,
          itemIndex: n,
          forceLate: useLate,
          fulfillmentMode,
          payerMobile,
        });
        await wa.send({
          to: from,
          body: [
            "Almost there — save a delivery address once:",
            "Save HOME Tower 3, Flat 1204, OMR",
            "",
            "We’ll place this order right after and send Pay.",
            "Or: Order <kitchen> 1 PICKUP",
            "Or: Order <kitchen> 1 HOME ARRANGE (you arrange auto/porter)",
          ].join("\n"),
          buttons: ["Addresses", "Menu"],
        });
        return { ok: true, intent: placeIntent, error: "no_address", replies: replies() };
      }
      if (addr.kind === "need_label" || addr.kind === "missing_label") {
        const prefix = useLate ? "Late" : "Order";
        await setWaSession(db, mobile, "PICK_ADDRESS", {
          cookSlug: slug,
          kitchenName: menu.cook.kitchenName,
          itemIndex: n,
          forceLate: useLate,
          fulfillmentMode,
          payerMobile,
        });
        await wa.send({
          to: from,
          body: [
            addr.kind === "missing_label" ? addr.error : "Deliver where? Reply 1 / 2 or tap:",
            ...addr.list.map((a, i) => `${i + 1}. ${a.label} — ${a.line1}`),
          ].join("\n"),
          buttons: addr.list.slice(0, 3).map((a) => `${prefix} ${slug} ${n} ${a.label}`),
        });
        return { ok: true, intent: placeIntent, pickAddress: true, replies: replies() };
      }
      addressId = addr.addressId;
      addressLabelResolved = addr.label;
    }

    try {
      if (useLate) {
        const order = await requestLateOrder(db, {
          customerMobile: mobile,
          cookSlug: slug,
          menuItemId: item.id,
          qty: 1,
          spice: "NORMAL",
          channel: "WHATSAPP_BOT",
          addressId,
          fulfillmentMode,
          payerMobile,
        });
        await clearWaSession(db, mobile);
        await wa.send({
          to: from,
          body: [
            `⏳ Late request ${order.publicId}`,
            `${menu.cook.kitchenName} · ${menu.mealLabel ?? "Lunch"} · ${localizedDishName(waLocale, item)}`,
            fulfillmentMode === "PICKUP"
              ? "Pickup at kitchen landmark (shown after pay)"
              : fulfillmentMode === "CUSTOMER_ARRANGE"
                ? `You arrange auto/porter · ${addressLabelResolved}`
                : `Deliver to ${addressLabelResolved}`,
            payerMobile ? `Family pays: ${payerMobile}` : null,
            `ETA if accepted: ${menu.deliveryWindow ?? "12:00–13:00"}`,
            "Waiting for cook to accept. You’ll get a Pay button if they approve — no charge yet.",
          ]
            .filter(Boolean)
            .join("\n"),
          buttons: ["Menu", "Help"],
        });
        return {
          ok: true,
          intent: placeIntent,
          publicId: order.publicId,
          pendingApproval: true,
          replies: replies(),
        };
      }

      const order = await createOrder(db, {
        customerMobile: mobile,
        cookSlug: slug,
        menuItemId: item.id,
        qty: 1,
        spice: "NORMAL",
        channel: "WHATSAPP_BOT",
        addressId,
        fulfillmentMode,
        payerMobile,
      });
      await clearWaSession(db, mobile);
      const foodPaise = Math.max(0, (item.pricePaise ?? 0) * 1);
      const deliveryPaise = Number(order.deliveryPaise ?? 0);
      const platformPaise = Number(order.platformFeePaise ?? 0);
      const totalPaise = foodPaise + deliveryPaise + platformPaise;
      const feePaise = Number(order.convenienceFeePaise ?? 0);
      const creditPaise = Number(order.creditAppliedPaise ?? 0);
      const paidByCredit = order.paymentMethod === "CREDIT";
      const allergenList = Array.isArray(item.allergens)
        ? (item.allergens as string[]).filter(Boolean)
        : [];
      await wa.send({
        to: from,
        body: [
          wt("wa.orderCreated", { id: order.publicId }),
          wt("wa.orderKitchenLine", {
            kitchen: menu.cook.kitchenName,
            meal: menu.mealLabel ?? "Lunch",
            dish: localizedDishName(waLocale, item),
          }),
          allergenList.length
            ? wt("wa.allergens", { list: allergenList.join(", ") })
            : null,
          wt("wa.priceBreakdown", {
            food: (foodPaise / 100).toFixed(0),
            delivery: (deliveryPaise / 100).toFixed(0),
            platform: (platformPaise / 100).toFixed(0),
            total: (totalPaise / 100).toFixed(0),
          }),
          fulfillmentMode === "PICKUP"
            ? wt("wa.pickupAfterPay")
            : fulfillmentMode === "CUSTOMER_ARRANGE"
              ? `You arrange auto/porter · ${addressLabelResolved}`
              : wt("wa.deliverTo", { label: addressLabelResolved ?? "" }),
          feePaise || creditPaise
            ? wt("wa.feeCreditLine", {
                fee: (feePaise / 100).toFixed(2),
                credit: (creditPaise / 100).toFixed(2),
                pay: ((totalPaise + feePaise - creditPaise) / 100).toFixed(2),
              })
            : null,
          payerMobile ? wt("wa.familyPays", { mobile: payerMobile }) : null,
          wt("wa.orderWindow", {
            cutoff: menu.cutoff ?? menu.lunchCutoff ?? "08:00",
            window: menu.deliveryWindow ?? "12:00–13:00",
          }),
          paidByCredit
            ? wt("wa.paidWithCredit")
            : payerMobile
              ? wt("wa.payFamily", { id: order.publicId })
              : wt("wa.payTap", { id: order.publicId }),
          order.paymentUrl && !paidByCredit ? wt("wa.payLink", { url: order.paymentUrl }) : null,
        ]
          .filter(Boolean)
          .join("\n"),
        buttons: ["Pay", "Menu", "Orders"],
      });
      return {
        ok: true,
        intent: placeIntent,
        publicId: order.publicId,
        gatewayTxnId: order.gatewayTxnId,
        paymentUrl: order.paymentUrl,
        replies: replies(),
      };
    } catch (e) {
      const msg = publicErrorMessage(e, waLocale);
      if (!useLate && /cut-off passed/i.test(msg)) {
        await wa.send({
          to: from,
          body: `${msg}\n\nYou can still ask the cook: Late ${slug} ${idx + 1} HOME`,
          buttons: [`Late ${slug} ${idx + 1} HOME`, "Menu"],
        });
        return { ok: true, intent: placeIntent, error: msg, replies: replies() };
      }
      await wa.send({ to: from, body: msg, buttons: ["Menu", "Addresses"] });
      return { ok: true, intent: placeIntent, error: msg, replies: replies() };
    }
  }


  return {
    db,
    from,
    text,
    image,
    intent,
    wa,
    mobile,
    get waLocale() { return waLocale; },
    set waLocale(v: Locale) { waLocale = v; },
    wt,
    replies,
    waSafe,
    customerServicePin,
    resolveWaDeliveryAddress,
    sendKitchenMenuWa,
    placeOrRequestLunch,
    ensureCustomerUser,
    getCustomerPreferredLocale,
    getCustomerProfile,
    clearWaSession,
    getWaSession,
    setWaSession,
  };
}
