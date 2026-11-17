import {
  parseCancelCommand,
  parseFollowCommand,
  parseLateCommand,
  parseOrderCommand,
  parseWeekCommand,
} from "@localmeals/adapters";
import { serviceDateISO } from "@localmeals/domain";
import {
  cancelCheckout,
  cancelOrder,
  createOrderBatch,
  getKitchenAdvanceMealOptions,
  getKitchenWeekPlan,
  listKitchens,
  listOrdersForCustomer,
} from "../../services/orders.js";
import {
  followKitchen,
  listFollowedKitchens,
  unfollowKitchen,
} from "../../services/kitchenFollow.js";
import { publicErrorMessage } from "../../httpErrors.js";
import {
  localizedDishName,
  localizedMealPeriod,
  localizedWeekday,
  type Locale,
  type MsgKey,
} from "@localmeals/i18n";
import type { WaSession } from "../session.js";

export async function handleOrderFlow(s: WaSession): Promise<object> {
  const {
    db, from, text, intent, wa, mobile, replies, waSafe, wt,
    customerServicePin, resolveWaDeliveryAddress, sendKitchenMenuWa, placeOrRequestLunch,
    ensureCustomerUser, clearWaSession, getWaSession, setWaSession,
  } = s;
  let { waLocale } = { waLocale: s.waLocale };
  const setLocale = (v: Locale) => { s.waLocale = v; waLocale = v; };

  if (intent === "ORDERS") {
    return await waSafe("ORDERS", async () => {

    const today = serviceDateISO();
    const openStatuses = new Set([
      "PENDING_APPROVAL",
      "AWAITING_PAYMENT",
      "CONFIRMING_PAYMENT",
      "PAID",
      "COOKING",
      "PACKED",
      "DISPATCHED",
      "DELAYED",
    ]);
    const { orders: history } = await listOrdersForCustomer(db, mobile, 30);
    // WhatsApp: upcoming / in-flight only — easier Pay & Cancel
    const upcoming = history
      .filter((o) => openStatuses.has(o.status) && o.serviceDate >= today)
      .sort((a, b) => a.serviceDate.localeCompare(b.serviceDate) || b.id - a.id)
      .slice(0, 8);
    if (!upcoming.length) {
      await wa.send({
        to: from,
        body: wt("wa.ordersEmpty"),
        buttons: ["Menu", "Week sri-sai"],
      });
      return { ok: true, intent, empty: true, replies: replies() };
    }
    const lines = upcoming.map((o) => {
      const total = (o.totalPaise / 100).toFixed(0);
      const statusKey = `wa.status.${o.status}` as MsgKey;
      const statusLabel = wt(statusKey) !== statusKey ? wt(statusKey) : o.status;
      const payHint =
        o.status === "AWAITING_PAYMENT"
          ? ` → Pay ${o.checkoutId ?? o.publicId}`
          : o.cancellable
            ? ` → Cancel ${o.publicId}`
            : "";
      return `• ${o.publicId} · ${o.serviceDate} · ${o.qty}× ${localizedDishName(waLocale, o)} · ${statusLabel} · ₹${total}${payHint}`;
    });
    const unpaid = upcoming.find((o) => o.status === "AWAITING_PAYMENT");
    const canCancel = upcoming.find((o) => o.cancellable);
    await wa.send({
      to: from,
      body: [
        wt("wa.ordersTitle"),
        "",
        ...lines,
        "",
        wt("wa.ordersHint"),
      ].join("\n"),
      buttons: [
        unpaid ? `Pay ${unpaid.checkoutId ?? unpaid.publicId}` : null,
        canCancel ? `Cancel ${canCancel.publicId}` : null,
        "Menu",
      ].filter(Boolean) as string[],
    });
    return { ok: true, intent, count: upcoming.length, replies: replies() };
        });
  }

  if (intent === "FOLLOW" || intent === "UNFOLLOW") {
    const { slug } = parseFollowCommand(text);
    if (!slug) {
      const kitchens = await listKitchens(db, await customerServicePin());
      const followed = await listFollowedKitchens(db, mobile);
      await wa.send({
        to: from,
        body: [
          intent === "FOLLOW"
            ? "Follow which kitchen for new-menu alerts?"
            : "Unfollow which kitchen?",
          ...kitchens.map((k) => `• ${intent === "FOLLOW" ? "Follow" : "Unfollow"} ${k.slugHandle}`),
          followed.length
            ? `\nFollowing: ${followed.map((f) => f.slugHandle).join(", ")}`
            : "\nYou’re not following any kitchen yet.",
        ].join("\n"),
        buttons: kitchens
          .slice(0, 3)
          .map((k) => `${intent === "FOLLOW" ? "Follow" : "Unfollow"} ${k.slugHandle}`),
      });
      return { ok: true, intent, needSlug: true, replies: replies() };
    }
    try {
      if (intent === "FOLLOW") {
        const res = await followKitchen(db, mobile, slug);
        await wa.send({
          to: from,
          body: res.alreadyFollowing
            ? `You’re already following ${res.cook.kitchenName}. We’ll ping when they post.`
            : `✅ Following ${res.cook.kitchenName}. You’ll get WhatsApp when they post a new plate.\nUnfollow ${slug} anytime.`,
          buttons: [`Menu ${slug}`, `Week ${slug}`, "Orders"],
        });
      } else {
        const res = await unfollowKitchen(db, mobile, slug);
        await wa.send({
          to: from,
          body: `Unfollowed ${res.cook.kitchenName}. No more menu alerts from them.`,
          buttons: ["Menu", "Orders"],
        });
      }
      return { ok: true, intent, slug, replies: replies() };
    } catch (e) {
      await wa.send({ to: from, body: publicErrorMessage(e, waLocale), buttons: ["Menu"] });
      return { ok: true, intent, error: publicErrorMessage(e, waLocale), replies: replies() };
    }
  }

  if (intent === "WEEK") {
    const parsed = parseWeekCommand(text);
    const kitchens = await listKitchens(db, await customerServicePin());
    if (!parsed.slug) {
      await wa.send({
        to: from,
        body: [
          "Advance / week cart — pick a kitchen, then Breakfast · Lunch · Dinner.",
          ...kitchens.map((k) => `• Week ${k.slugHandle}`),
          "",
          "Then: Week <kitchen> lunch all   or   Week <kitchen> dinner Mon Wed",
        ].join("\n"),
        buttons: kitchens.slice(0, 3).map((k) => `Week ${k.slugHandle}`),
      });
      return { ok: true, intent, needSlug: true, replies: replies() };
    }

    const mealChoices = await getKitchenAdvanceMealOptions(db, parsed.slug, { days: 7 });
    if (!mealChoices) {
      await wa.send({
        to: from,
        body: `Kitchen "${parsed.slug}" not found.`,
        buttons: ["Menu"],
      });
      return { ok: true, intent, error: "kitchen_not_found", replies: replies() };
    }

    const mealShort: Record<"BREAKFAST" | "LUNCH" | "DINNER", string> = {
      BREAKFAST: "B",
      LUNCH: "L",
      DINNER: "D",
    };

    let mealType = parsed.mealType;
    if (!mealType) {
      if (!mealChoices.meals.length) {
        await wa.send({
          to: from,
          body: `${mealChoices.cook.kitchenName}: no advance Breakfast / Lunch / Dinner plates this week. Try Menu for today.`,
          buttons: [`Menu ${parsed.slug}`, "Orders"],
        });
        return { ok: true, intent, empty: true, replies: replies() };
      }
      if (mealChoices.meals.length > 1) {
        await wa.send({
          to: from,
          body: [
            `📅 ${mealChoices.cook.kitchenName} · advance menu`,
            "Pick a meal — then choose days:",
            "",
            ...mealChoices.meals.map(
              (m) =>
                `• ${m.mealLabel} · ${m.openDayCount} day(s)${m.sampleItem ? ` · e.g. ${m.sampleItem}` : ""}`,
            ),
            "",
            `Or type: Week ${parsed.slug} lunch`,
          ].join("\n"),
          buttons: mealChoices.meals
            .slice(0, 3)
            .map((m) => `Week ${parsed.slug} ${mealShort[m.mealType]}`),
        });
        return { ok: true, intent, slug: parsed.slug, pickMeal: true, replies: replies() };
      }
      mealType = mealChoices.meals[0].mealType;
    }

    const week = await getKitchenWeekPlan(db, parsed.slug, { days: 7, mealType });
    if (!week) {
      await wa.send({
        to: from,
        body: `Kitchen "${parsed.slug}" not found.`,
        buttons: ["Menu"],
      });
      return { ok: true, intent, error: "kitchen_not_found", replies: replies() };
    }
    if (week.mealEnabled === false) {
      await wa.send({
        to: from,
        body: `${week.cook.kitchenName} doesn’t offer ${week.mealLabel.toLowerCase()} yet. Try Week ${parsed.slug} for other meals.`,
        buttons: [`Week ${parsed.slug}`, "Menu"],
      });
      return { ok: true, intent, error: "meal_disabled", replies: replies() };
    }

    const openDays = week.plan.filter((d) => d.orderingOpen && d.menus.length > 0);
    const wantsCheckout = parsed.all === true || (parsed.dayTokens && parsed.dayTokens.length > 0);
    const mealCmd = mealShort[mealType];

    const weekFulfillmentEarly =
      parsed.fulfillmentMode === "PICKUP" ? "PICKUP" : "DELIVERY";
    if (wantsCheckout && weekFulfillmentEarly === "DELIVERY") {
      const addr = await resolveWaDeliveryAddress(parsed.addressLabel);
      if (addr.kind === "empty") {
        await wa.send({
          to: from,
          body: [
            "Save a delivery address before week checkout.",
            "Reply: Save HOME <tower / flat / street>",
            "Or pickup: Week <kitchen> L all PICKUP",
          ].join("\n"),
          buttons: ["Addresses", `Week ${parsed.slug} ${mealCmd}`, "Menu"],
        });
        return { ok: true, intent, error: "no_address", replies: replies() };
      }
      if (addr.kind === "need_label" || addr.kind === "missing_label") {
        const labels = addr.list.slice(0, 3).map((a) => a.label);
        await wa.send({
          to: from,
          body: [
            addr.kind === "missing_label" ? addr.error : "Pick where to deliver this week cart:",
            ...addr.list.map((a) => `• ${a.label} — ${a.line1}`),
            "",
            `Reply: Week ${parsed.slug} ${mealCmd} all HOME`,
          ].join("\n"),
          buttons: labels.map(
            (lab) =>
              `Week ${parsed.slug} ${mealCmd} ${parsed.all ? "all" : (parsed.dayTokens ?? []).slice(0, 2).join(" ") || "all"} ${lab}`.replace(
                /\s+/g,
                " ",
              ),
          ),
        });
        return { ok: true, intent, pickAddress: true, replies: replies() };
      }
    }

    if (!wantsCheckout) {
      if (!openDays.length) {
        await wa.send({
          to: from,
          body: wt("wa.noOpenWeekDays", {
            kitchen: week.cook.kitchenName,
            meal: week.mealLabel.toLowerCase(),
            slug: parsed.slug,
          }),
          buttons: [`Week ${parsed.slug}`, `Menu ${parsed.slug}`, "Orders"],
        });
        return { ok: true, intent, empty: true, replies: replies() };
      }
      const firstDay = openDays[0]?.dayLabel ?? "Tue";
      const sampleDays = openDays
        .slice(0, 3)
        .map((d) => d.dayLabel)
        .join(" ");
      await wa.send({
        to: from,
        body: [
          wt("wa.weekHeader", {
            kitchen: week.cook.kitchenName,
            meal: localizedMealPeriod(waLocale, week.mealType),
          }),
          wt("wa.weekMeta", { cutoff: week.cutoff, window: week.deliveryWindow }),
          week.weekDiscount?.label
            ? wt("wa.weekDeal", { deal: week.weekDiscount.label })
            : null,
          "",
          ...openDays.map((d) => {
            const first = d.menus[0];
            const day = localizedWeekday(waLocale, d.dayOfWeek);
            return `• ${day} ${d.serviceDate.slice(5)} — ${localizedDishName(waLocale, first)} ₹${(first.pricePaise / 100).toFixed(0)}${d.menus.length > 1 ? ` (+${d.menus.length - 1})` : ""}`;
          }),
          "",
          wt("wa.howToOrder"),
          wt("wa.howOneDay", { slug: parsed.slug, mealCmd, day: firstDay }),
          wt("wa.howFewDays", { slug: parsed.slug, mealCmd, days: sampleDays }),
          wt("wa.howAllDays", { slug: parsed.slug, mealCmd }),
          wt("wa.howPickup", { slug: parsed.slug, mealCmd, day: firstDay }),
        ]
          .filter(Boolean)
          .join("\n"),
        buttons: [
          `Week ${parsed.slug} ${mealCmd} ${firstDay}`,
          `Week ${parsed.slug} ${mealCmd} all`,
          `Menu ${parsed.slug}`,
        ],
      });
      return { ok: true, intent, slug: parsed.slug, mealType, preview: true, replies: replies() };
    }

    const itemIndex = Math.max(1, parsed.itemIndex ?? 1);
    let selected = openDays;
    if (parsed.dayTokens?.length) {
      const dowAlias: Record<string, number> = {
        sun: 0,
        sunday: 0,
        mon: 1,
        monday: 1,
        tue: 2,
        tues: 2,
        tuesday: 2,
        wed: 3,
        wednesday: 3,
        thu: 4,
        thur: 4,
        thursday: 4,
        fri: 5,
        friday: 5,
        sat: 6,
        saturday: 6,
      };
      selected = [];
      for (const tok of parsed.dayTokens) {
        const dow = dowAlias[tok];
        if (dow == null) continue;
        const day = openDays.find(
          (d) => d.dayOfWeek === dow && !selected.some((s) => s.serviceDate === d.serviceDate),
        );
        if (day) selected.push(day);
      }
    }

    if (!selected.length) {
      await wa.send({
        to: from,
        body: `No matching open days for Week ${parsed.slug}. Send Week ${parsed.slug} to see options.`,
        buttons: [`Week ${parsed.slug}`, "Menu"],
      });
      return { ok: true, intent, empty: true, replies: replies() };
    }

    const lines = [];
    for (const d of selected) {
      const item = d.menus[itemIndex - 1] ?? d.menus[0];
      if (!item) continue;
      lines.push({
        menuItemId: item.id,
        serviceDate: d.serviceDate,
        qty: 1,
        spice: "NORMAL" as const,
      });
    }
    if (!lines.length) {
      await wa.send({
        to: from,
        body: "Could not build week cart — no plates on those days.",
        buttons: [`Week ${parsed.slug}`, "Menu"],
      });
      return { ok: true, intent, error: "no_lines", replies: replies() };
    }

    const weekFulfillment = parsed.fulfillmentMode === "PICKUP" ? "PICKUP" : "DELIVERY";
    let weekAddressId: number | null = null;
    let weekAddrLabel = "PICKUP";
    if (weekFulfillment === "DELIVERY") {
      const addrFinal = await resolveWaDeliveryAddress(parsed.addressLabel);
      if (addrFinal.kind !== "ok") {
        await wa.send({
          to: from,
          body: "Choose a delivery address label (HOME / OFFICE) and try again.",
          buttons: [`Week ${parsed.slug} ${mealCmd}`, "Addresses"],
        });
        return { ok: true, intent, error: "no_address", replies: replies() };
      }
      weekAddressId = addrFinal.addressId;
      weekAddrLabel = addrFinal.label;
    }

    try {
      const batch = await createOrderBatch(db, {
        customerMobile: mobile,
        cookSlug: parsed.slug,
        channel: "WHATSAPP_BOT",
        addressId: weekAddressId,
        fulfillmentMode: weekFulfillment,
        payerMobile: parsed.payerMobile ?? null,
        lines,
      });
      const discountLine =
        batch.foodDiscountTotalPaise > 0
          ? `Week discount −₹${(batch.foodDiscountTotalPaise / 100).toFixed(0)} (food only)`
          : week.weekDiscount?.label
            ? `Tip: ${week.weekDiscount.label} on week carts`
            : null;
      await wa.send({
        to: from,
        body: [
          `✅ Week cart ${batch.checkoutId}`,
          `${week.cook.kitchenName} · ${week.mealLabel} · ${batch.orders.length} day(s)`,
          weekFulfillment === "PICKUP"
            ? "Pickup at kitchen landmark (after pay)"
            : `Deliver to ${weekAddrLabel}`,
          parsed.payerMobile ? `Family pays: ${parsed.payerMobile}` : null,
          ...batch.orders.map(
            (o) => `• ${o.serviceDate} · ${o.qty}× ${localizedDishName(waLocale, o)}`,
          ),
          discountLine,
          `Total ₹${(batch.totalPaise / 100).toFixed(0)}`,
          batch.paymentUrl ? `Pay: ${batch.paymentUrl}` : null,
          "",
          "One payment covers all days. Delivery + ₹7 fee never discounted.",
        ]
          .filter(Boolean)
          .join("\n"),
        buttons: [`Pay ${batch.checkoutId}`, "Orders", "Cancel"],
      });
      return {
        ok: true,
        intent,
        checkoutId: batch.checkoutId,
        gatewayTxnId: batch.gatewayTxnId,
        paymentUrl: batch.paymentUrl,
        replies: replies(),
      };
    } catch (e) {
      await wa.send({
        to: from,
        body: publicErrorMessage(e, waLocale),
        buttons: [`Week ${parsed.slug}`, "Orders", "Menu"],
      });
      return { ok: true, intent, error: publicErrorMessage(e, waLocale), replies: replies() };
    }
  }

  if (intent === "ORDER") {
    const { slug, itemIndex, addressLabel, fulfillmentMode, payerMobile } =
      parseOrderCommand(text);
    if (!slug) {
      const kitchens = await listKitchens(db, await customerServicePin());
      if (kitchens.length === 1) {
        return sendKitchenMenuWa(kitchens[0].slugHandle);
      }
      const kitchenOpts = kitchens.slice(0, 5).map((k, i) => ({
        n: i + 1,
        slug: k.slugHandle,
        name: k.kitchenName,
      }));
      await setWaSession(db, mobile, "PICK_KITCHEN", { kitchens: kitchenOpts });
      await wa.send({
        to: from,
        body: [
          wt("wa.whichKitchen"),
          ...kitchenOpts.map((k) => `${k.n}. ${k.name}`),
        ].join("\n"),
        buttons: kitchenOpts.slice(0, 3).map((k) => k.slug),
      });
      return { ok: true, intent, needSlug: true, replies: replies() };
    }
    return placeOrRequestLunch({
      intent: "ORDER",
      slug,
      itemIndex,
      addressLabel,
      fulfillmentMode,
      payerMobile,
      forceLate: false,
    });
  }

  if (intent === "LATE") {
    const { slug, itemIndex, addressLabel, fulfillmentMode, payerMobile } =
      parseLateCommand(text);
    if (!slug) {
      const kitchens = await listKitchens(db, await customerServicePin());
      await wa.send({
        to: from,
        body: [
          "Late order — which kitchen?",
          ...kitchens.map((k) => `• Late ${k.slugHandle}`),
          "",
          "Cook must accept, then you pay.",
          "Pickup: Late <kitchen> 1 PICKUP",
        ].join("\n"),
        buttons: kitchens.slice(0, 3).map((k) => `Late ${k.slugHandle}`),
      });
      return { ok: true, intent, needSlug: true, replies: replies() };
    }
    return placeOrRequestLunch({
      intent: "LATE",
      slug,
      itemIndex,
      addressLabel,
      fulfillmentMode,
      payerMobile,
      forceLate: true,
    });
  }

  if (intent === "CANCEL") {
    const { publicId: cancelId, checkoutId } = parseCancelCommand(text);
    try {
      if (checkoutId) {
        const res = await cancelCheckout(db, checkoutId);
        await wa.send({
          to: from,
          body: [
            `🚫 Cancelled week ${checkoutId}`,
            ...res.cancelled.map((o) => `• ${o.publicId}`),
            res.skipped.length
              ? `Skipped: ${res.skipped.map((s) => s.publicId).join(", ")}`
              : null,
            "",
            "Before cut-off only. Order again from Menu anytime.",
          ]
            .filter(Boolean)
            .join("\n"),
          buttons: ["Menu"],
        });
        return {
          ok: true,
          intent,
          checkoutId,
          cancelled: res.cancelled,
          replies: replies(),
        };
      }

      if (cancelId) {
        const updated = await cancelOrder(db, cancelId);
        const requested = updated.mode === "cancel_requested";
        await wa.send({
          to: from,
          body: requested
            ? [
                `Asked kitchen to cancel · ${updated.publicId}`,
                `${updated.qty}× ${localizedDishName(waLocale, updated)} · ${updated.serviceDate}`,
                "",
                "Waiting for cook Accept (refund) or Decline (keep order).",
              ].join("\n")
            : [
                `🚫 Cancelled ${updated.publicId}`,
                `${updated.qty}× ${localizedDishName(waLocale, updated)} · ${updated.serviceDate}`,
                "",
                "You can order again before cut-off from Menu.",
              ].join("\n"),
          buttons: requested ? ["Orders"] : ["Menu"],
        });
        return { ok: true, intent, publicId: cancelId, replies: replies() };
      }

      const { orders: history } = await listOrdersForCustomer(db, mobile, 10);
      const open = history.filter((o) => o.cancellable || o.cancelRequestable);
      if (!open.length) {
        await wa.send({
          to: from,
          body: "Nothing to cancel. After cut-off, paid orders need kitchen Accept; cooking/delivered need Help.",
          buttons: ["Menu", "Help"],
        });
        return { ok: true, intent, empty: true, replies: replies() };
      }
      await wa.send({
        to: from,
        body: [
          "Cancel which order?",
          ...open.slice(0, 5).map((o) => {
            const id =
              o.checkoutId && open.filter((x) => x.checkoutId === o.checkoutId).length > 1
                ? o.checkoutId
                : o.publicId;
            const tag = o.cancelRequestable ? " · ask kitchen" : "";
            return `• Cancel ${id} — ${o.serviceDate} · ${localizedDishName(waLocale, o)}${tag}`;
          }),
          "",
          "Week carts: Cancel CHK-xxxx cancels all open days in that checkout.",
        ].join("\n"),
        buttons: open.slice(0, 3).map((o) =>
          o.checkoutId && open.filter((x) => x.checkoutId === o.checkoutId).length > 1
            ? `Cancel ${o.checkoutId}`
            : `Cancel ${o.publicId}`,
        ),
      });
      return { ok: true, intent, needPublicId: true, replies: replies() };
    } catch (e) {
      await wa.send({
        to: from,
        body: publicErrorMessage(e, waLocale),
        buttons: ["Menu", "Help"],
      });
      return { ok: true, intent, error: publicErrorMessage(e, waLocale), replies: replies() };
    }
  }

  return { ok: true, intent, unhandled: true as const, replies: replies() };
}
