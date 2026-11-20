import {
  downloadWhatsAppMedia,
  parseCookMenuAdd,
  parseDeliverCommand,
  parseLateDecideCommand,
} from "@localmeals/adapters";
import {
  acceptCancelRequest,
  approveLateOrder,
  declineCancelRequest,
  declineLateOrder,
  getOrderByPublicId,
  listPendingCancelRequests,
  listPendingLateOrders,
} from "../../services/orders.js";
import {
  addCookMenuItem,
  findCookByMobile,
  getCookDayStatus,
  listCookDailyMenu,
  markDelivered,
  markDispatched,
  markPacked,
  markStartCooking,
  updateCookMenuItem,
} from "../../services/cookOps.js";
import { saveMenuImageBuffer } from "../../uploads.js";
import { publicErrorMessage } from "../../httpErrors.js";
import type { Locale } from "@localmeals/i18n";
import type { WaSession } from "../session.js";
import fs from "node:fs";

async function resolveInboundMenuImage(
  image: NonNullable<WaSession["image"]>,
): Promise<{ url: string } | { error: string }> {
  try {
    if (image.imageUrl?.startsWith("/uploads/")) {
      return { url: image.imageUrl };
    }
    if (image.imageBase64) {
      const buf = Buffer.from(image.imageBase64, "base64");
      const url = await saveMenuImageBuffer(buf, image.mimeType ?? "image/jpeg");
      return { url };
    }
    if (image.mediaId) {
      const { buffer, mimeType } = await downloadWhatsAppMedia(image.mediaId);
      const url = await saveMenuImageBuffer(buffer, image.mimeType ?? mimeType);
      return { url };
    }
    // Local mock: absolute path under uploads dir (dev only)
    if (image.imageUrl && fs.existsSync(image.imageUrl)) {
      const buf = fs.readFileSync(image.imageUrl);
      const url = await saveMenuImageBuffer(buf, image.mimeType ?? "image/jpeg");
      return { url };
    }
    return { error: "No image data" };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function handleCookOps(s: WaSession): Promise<object> {
  const {
    db, from, text, image, intent, wa, mobile, replies,
    clearWaSession, getWaSession, setWaSession,
  } = s;
  let { waLocale } = { waLocale: s.waLocale };
  const setLocale = (v: Locale) => { s.waLocale = v; waLocale = v; };
  void setLocale;

  /** Kitchen ops — only if sender is a registered cook mobile. */
  if (
    intent === "COOK_STATUS" ||
    intent === "COOK_COOKING" ||
    intent === "COOK_PACK" ||
    intent === "COOK_DISPATCH" ||
    intent === "COOK_DELIVER" ||
    intent === "COOK_LATE_LIST" ||
    intent === "COOK_LATE_ACCEPT" ||
    intent === "COOK_LATE_DECLINE" ||
    intent === "COOK_MENU_ADD" ||
    intent === "COOK_MENU_LIST" ||
    intent === "COOK_MENU_SKIP" ||
    intent === "COOK_MENU_PHOTO" ||
    intent === "COOK_CANCEL_LIST"
  ) {
    const cook = await findCookByMobile(db, mobile);
    if (!cook) {
      await wa.send({
        to: from,
        body: "Kitchen commands work from the cook WhatsApp number only. Customers: Menu · Order · Late · Pay.",
        buttons: ["Menu", "Help"],
      });
      return { ok: true, intent, error: "not_cook", replies: replies() };
    }

    try {
      if (intent === "COOK_MENU_ADD") {
        const parsed = parseCookMenuAdd(text);
        if (!parsed.itemName || parsed.priceRupees == null) {
          await wa.send({
            to: from,
            body: [
              "Add today’s lunch plate like this:",
              "Add Sambar rice 80",
              "Add Chicken biryani 120 nonveg",
              "",
              "Then send a photo, or Skip.",
            ].join("\n"),
            buttons: ["My menu", "Status"],
          });
          return { ok: true, intent, needParse: true, replies: replies() };
        }
        const row = await addCookMenuItem(db, cook.slugHandle, {
          itemName: parsed.itemName,
          priceRupees: parsed.priceRupees,
          isVeg: parsed.isVeg ?? true,
          mealType: "LUNCH",
        });
        await setWaSession(db, mobile, "AWAIT_MENU_PHOTO", {
          menuItemId: row.id,
          cookSlug: cook.slugHandle,
          itemName: row.itemName,
        });
        await wa.send({
          to: from,
          body: [
            `✅ Added · ${row.itemName} · ₹${(row.pricePaise / 100).toFixed(0)}`,
            `${row.isVeg ? "Veg" : "Non-veg"} · lunch today`,
            "",
            "Send a photo now to show on the menu, or Skip.",
          ].join("\n"),
          buttons: ["Skip", "My menu", "Status"],
        });
        return {
          ok: true,
          intent,
          menuItemId: row.id,
          itemName: row.itemName,
          replies: replies(),
        };
      }

      if (intent === "COOK_MENU_LIST") {
        const day = await listCookDailyMenu(db, cook.slugHandle, { view: "day", mealType: "LUNCH" });
        const weekly =
          day.view === "day" && Array.isArray(day.weeklyForDay) ? day.weeklyForDay : [];
        const plates = [...day.menus.filter((m) => m.isAvailable), ...weekly];
        if (!plates.length) {
          await wa.send({
            to: from,
            body: [
              `No lunch plates for ${day.serviceDate} yet.`,
              "Add one: Add Sambar rice 80",
            ].join("\n"),
            buttons: ["Status"],
          });
          return { ok: true, intent, empty: true, replies: replies() };
        }
        await wa.send({
          to: from,
          body: [
            `📋 ${cook.kitchenName} · lunch ${day.serviceDate}`,
            ...plates.map(
              (m, i) =>
                `${i + 1}. ${m.itemName} · ₹${(m.pricePaise / 100).toFixed(0)}${m.isVeg ? "" : " · NV"}${m.imageUrl ? " · 📷" : ""}`,
            ),
            "",
            "Add another: Add <dish> <rupees>",
          ].join("\n"),
          buttons: ["Status", "Skip"],
        });
        return { ok: true, intent, count: plates.length, replies: replies() };
      }

      if (intent === "COOK_MENU_SKIP") {
        const sess = await getWaSession(db, mobile);
        if (sess?.step === "AWAIT_MENU_PHOTO") {
          await clearWaSession(db, mobile);
          await wa.send({
            to: from,
            body: "Skipped photo. Plate stays on today’s menu without an image.",
            buttons: ["My menu", "Status"],
          });
          return { ok: true, intent, skipped: true, replies: replies() };
        }
        await wa.send({
          to: from,
          body: "Nothing to skip. Add a plate first: Add Sambar rice 80",
          buttons: ["My menu", "Status"],
        });
        return { ok: true, intent, nothing: true, replies: replies() };
      }

      if (intent === "COOK_MENU_PHOTO") {
        const sess = await getWaSession(db, mobile);
        if (sess?.step !== "AWAIT_MENU_PHOTO" || !sess.payload.menuItemId) {
          await wa.send({
            to: from,
            body: "Add a plate first (Add Sambar rice 80), then send the photo.",
            buttons: ["My menu", "Status"],
          });
          return { ok: true, intent, needAddFirst: true, replies: replies() };
        }
        if (!image) {
          await wa.send({
            to: from,
            body: "Send an image for the plate, or Skip.",
            buttons: ["Skip", "My menu"],
          });
          return { ok: true, intent, needImage: true, replies: replies() };
        }
        const resolved = await resolveInboundMenuImage(image);
        if ("error" in resolved) {
          await wa.send({
            to: from,
            body: `Could not save photo: ${resolved.error}`,
            buttons: ["Skip", "My menu"],
          });
          return { ok: true, intent, error: resolved.error, replies: replies() };
        }
        const updated = await updateCookMenuItem(
          db,
          sess.payload.cookSlug ?? cook.slugHandle,
          sess.payload.menuItemId,
          { imageUrl: resolved.url },
        );
        await clearWaSession(db, mobile);
        await wa.send({
          to: from,
          body: [
            `📷 Photo attached · ${updated.itemName}`,
            "Customers will see it on Menu / kitchen page.",
          ].join("\n"),
          buttons: ["My menu", "Status"],
        });
        return {
          ok: true,
          intent,
          menuItemId: updated.id,
          imageUrl: updated.imageUrl,
          replies: replies(),
        };
      }

      if (intent === "COOK_CANCEL_LIST") {
        const cancelPending = await listPendingCancelRequests(db, cook.slugHandle);
        if (!cancelPending.orders.length) {
          await wa.send({
            to: from,
            body: "No cancel requests waiting.\n\nTap Status for today’s queue.",
            buttons: ["Status", "Late requests"],
          });
          return { ok: true, intent, empty: true, replies: replies() };
        }
        await wa.send({
          to: from,
          body: [
            `❎ Cancel requests · ${cook.kitchenName}`,
            ...cancelPending.orders.map(
              (o) =>
                `• ${o.publicId} · ${o.qty}× ${o.itemName}\n  ${o.customerMobile}\n  📍 ${o.deliveryTargetAddress || "—"}`,
            ),
            "",
            "Accept → full refund. Decline → keep cooking.",
          ].join("\n"),
          buttons: cancelPending.orders
            .slice(0, 3)
            .flatMap((o) => [`Accept ${o.publicId}`, `Decline ${o.publicId}`])
            .slice(0, 3),
        });
        return { ok: true, intent, count: cancelPending.orders.length, replies: replies() };
      }

      if (intent === "COOK_LATE_LIST") {
        const pending = await listPendingLateOrders(db, cook.slugHandle);
        if (!pending.orders.length) {
          await wa.send({
            to: from,
            body: `No late requests waiting.\n\nTap Status for today’s paid queue.`,
            buttons: ["Status", "Cooking"],
          });
          return { ok: true, intent, empty: true, replies: replies() };
        }
        const lines = pending.orders.map(
          (o) =>
            `• ${o.publicId} · ${o.qty}× ${o.itemName}\n  ${o.customerMobile}\n  📍 ${o.deliveryTargetAddress}`,
        );
        await wa.send({
          to: from,
          body: [
            `⏰ Late requests · ${cook.kitchenName}`,
            ...lines,
            "",
            "Accept → customer gets pay link. Decline → no charge.",
          ].join("\n"),
          buttons: pending.orders
            .slice(0, 3)
            .flatMap((o) => [`Accept ${o.publicId}`, `Decline ${o.publicId}`])
            .slice(0, 3),
        });
        return { ok: true, intent, count: pending.orders.length, replies: replies() };
      }

      if (intent === "COOK_LATE_ACCEPT") {
        const { publicId } = parseLateDecideCommand(text);
        if (!publicId) {
          const pending = await listPendingLateOrders(db, cook.slugHandle);
          await wa.send({
            to: from,
            body: pending.orders.length
              ? ["Accept which late request?", ...pending.orders.map((o) => `• Accept ${o.publicId}`)].join(
                  "\n",
                )
              : "No late requests. Send Late requests.",
            buttons: pending.orders.slice(0, 3).map((o) => `Accept ${o.publicId}`),
          });
          return { ok: true, intent, needPublicId: true, replies: replies() };
        }
        const order = await getOrderByPublicId(db, publicId);
        if (!order || order.cookId !== cook.id) {
          throw new Error("Request not found for your kitchen");
        }
        if (order.status === "CANCEL_REQUESTED") {
          await acceptCancelRequest(db, publicId, { channel: "WHATSAPP_BOT" });
          await wa.send({
            to: from,
            body: [
              `✅ Cancel allowed · ${publicId}`,
              "Customer will get a full refund.",
            ].join("\n"),
            buttons: ["Status"],
          });
          return { ok: true, intent, publicId, cancelAccepted: true, replies: replies() };
        }
        const approved = await approveLateOrder(db, publicId);
        await wa.send({
          to: from,
          body: [
            `✅ Accepted ${approved.publicId}`,
            "Pay link sent to customer on WhatsApp.",
            "You’ll see it under Status after they pay.",
          ].join("\n"),
          buttons: ["Late requests", "Status"],
        });
        return {
          ok: true,
          intent,
          publicId: approved.publicId,
          paymentUrl: approved.paymentUrl,
          gatewayTxnId: approved.gatewayTxnId,
          replies: replies(),
        };
      }

      if (intent === "COOK_LATE_DECLINE") {
        const { publicId } = parseLateDecideCommand(text);
        if (!publicId) {
          const pending = await listPendingLateOrders(db, cook.slugHandle);
          await wa.send({
            to: from,
            body: pending.orders.length
              ? ["Decline which late request?", ...pending.orders.map((o) => `• Decline ${o.publicId}`)].join(
                  "\n",
                )
              : "No late requests.",
            buttons: pending.orders.slice(0, 3).map((o) => `Decline ${o.publicId}`),
          });
          return { ok: true, intent, needPublicId: true, replies: replies() };
        }
        const order = await getOrderByPublicId(db, publicId);
        if (!order || order.cookId !== cook.id) {
          throw new Error("Request not found for your kitchen");
        }
        if (order.status === "CANCEL_REQUESTED") {
          await declineCancelRequest(db, publicId, "Kitchen could not cancel — food is being prepared", {
            channel: "WHATSAPP_BOT",
          });
          await wa.send({
            to: from,
            body: `❌ Kept order ${publicId}. Customer notified — continue cooking.`,
            buttons: ["Status", "Cooking"],
          });
          return { ok: true, intent, publicId, cancelDeclined: true, replies: replies() };
        }
        await declineLateOrder(db, publicId, "Kitchen could not take a late order");
        await wa.send({
          to: from,
          body: `❌ Declined ${publicId}. Customer notified — no charge.`,
          buttons: ["Late requests", "Status"],
        });
        return { ok: true, intent, publicId, replies: replies() };
      }

      if (intent === "COOK_STATUS") {
        const day = await getCookDayStatus(db, cook.slugHandle);
        const pending = await listPendingLateOrders(db, cook.slugHandle);
        const cancelPending = await listPendingCancelRequests(db, cook.slugHandle);
        const lateBlock =
          pending.orders.length > 0
            ? [
                "",
                `⏰ Late waiting (${pending.orders.length})`,
                ...pending.orders.map(
                  (o) => `• ${o.publicId} · ${o.qty}× ${o.itemName}`,
                ),
                "→ Late requests · or Accept LM-… / Decline LM-…",
              ]
            : [];
        const cancelBlock =
          cancelPending.orders.length > 0
            ? [
                "",
                `❎ Cancel asks (${cancelPending.orders.length})`,
                ...cancelPending.orders.map(
                  (o) => `• ${o.publicId} · ${o.qty}× ${o.itemName}`,
                ),
                "→ Accept LM-… (refund) / Decline LM-… (keep)",
              ]
            : [];
        if (!day.orders.length && !pending.orders.length && !cancelPending.orders.length) {
          await wa.send({
            to: from,
            body: `${cook.kitchenName} · ${day.serviceDate}\nNo paid orders or late requests.\n\nCooking · Packed · Dispatched · Late requests`,
            buttons: ["Late requests", "Cooking", "Packed"],
          });
          return { ok: true, intent, empty: true, replies: replies() };
        }
        const lines = day.orders.map(
          (o) => `• ${o.publicId} · ${o.status} · ${o.qty}× ${o.itemName}`,
        );
        const nextHint =
          cancelPending.orders.length > 0
            ? `Next: Accept ${cancelPending.orders[0].publicId} (cancel/refund) or Decline`
            : pending.orders.length > 0
              ? `Next: Accept ${pending.orders[0].publicId}`
              : day.orders.some((o) => o.status === "PAID" || o.status === "CANCEL_REQUESTED")
                ? "Next: Cooking"
                : day.orders.some((o) => o.status === "COOKING")
                  ? "Next: Packed"
                  : day.orders.some((o) => o.status === "PACKED")
                    ? "Next: Dispatched"
                    : day.orders.some((o) => o.status === "DISPATCHED" || o.status === "DELAYED")
                      ? `Next: Delivered ${day.orders.find((o) => o.status === "DISPATCHED" || o.status === "DELAYED")?.publicId}`
                      : "All clear";
        const statusButtons =
          cancelPending.orders.length > 0
            ? [
                `Accept ${cancelPending.orders[0].publicId}`,
                `Decline ${cancelPending.orders[0].publicId}`,
                "Status",
              ]
            : pending.orders.length > 0
              ? [`Accept ${pending.orders[0].publicId}`, "Late requests", "Cooking"]
              : ["Cooking", "Packed", "Dispatched"];
        await wa.send({
          to: from,
          body: [
            `👩‍🍳 ${cook.kitchenName} · ${day.serviceDate}`,
            ...(lines.length ? lines : ["(no paid lunch yet)"]),
            ...lateBlock,
            ...cancelBlock,
            "",
            nextHint,
          ].join("\n"),
          buttons: statusButtons.slice(0, 3),
        });
        return {
          ok: true,
          intent,
          count: day.orders.length,
          latePending: pending.orders.length,
          replies: replies(),
        };
      }

      if (intent === "COOK_COOKING") {
        const res = await markStartCooking(db, cook.slugHandle, undefined, undefined, {
          channel: "WHATSAPP_BOT",
        });
        await wa.send({
          to: from,
          body:
            res.cooking > 0
              ? `🔥 Cooking started · ${res.cooking} order(s)\n${res.publicIds.join(", ")}\n\nWhen ready: Packed`
              : "No PAID orders to start cooking. Run Status.",
          buttons: res.cooking > 0 ? ["Packed", "Status"] : ["Status"],
        });
        return { ok: true, intent, ...res, replies: replies() };
      }

      if (intent === "COOK_PACK") {
        const res = await markPacked(db, cook.slugHandle, undefined, undefined, {
          channel: "WHATSAPP_BOT",
        });
        await wa.send({
          to: from,
          body:
            res.packed > 0
              ? `📦 Packed · ${res.packed} order(s)\n${res.publicIds.join(", ")}\n\nWhen leaving: Dispatched`
              : "No COOKING orders to pack. Try Cooking first, or Status.",
          buttons: res.packed > 0 ? ["Dispatched", "Status"] : ["Cooking", "Status"],
        });
        return { ok: true, intent, ...res, replies: replies() };
      }

      if (intent === "COOK_DISPATCH") {
        const res = await markDispatched(db, cook.slugHandle, undefined, undefined, {
          channel: "WHATSAPP_BOT",
        });
        const first = res.publicIds[0];
        await wa.send({
          to: from,
          body:
            res.dispatched > 0
              ? `🛵 Dispatched · ${res.dispatched} order(s)\n${res.publicIds.join(", ")}\n\nAfter drop: Delivered ${first ?? "LM-xxxx"}`
              : "No PACKED orders to dispatch. Pack first, or Status.",
          buttons:
            res.dispatched > 0 && first
              ? [`Delivered ${first}`, "Status"]
              : ["Packed", "Status"],
        });
        return { ok: true, intent, ...res, replies: replies() };
      }

      if (intent === "COOK_DELIVER") {
        const { publicId } = parseDeliverCommand(text);
        if (!publicId) {
          const day = await getCookDayStatus(db, cook.slugHandle);
          const open = day.orders.filter(
            (o) => o.status === "DISPATCHED" || o.status === "DELAYED",
          );
          await wa.send({
            to: from,
            body: open.length
              ? [
                  "Which order was delivered?",
                  ...open.map((o) => `• Delivered ${o.publicId}`),
                ].join("\n")
              : "No dispatched orders. Send Status.",
            buttons: open.slice(0, 3).map((o) => `Delivered ${o.publicId}`),
          });
          return { ok: true, intent, needPublicId: true, replies: replies() };
        }
        const updated = await markDelivered(db, publicId, {
          cookId: cook.id,
          channel: "WHATSAPP_BOT",
        });
        await wa.send({
          to: from,
          body: `✅ ${updated.publicId} marked DELIVERED`,
          buttons: ["Status", "Dispatched"],
        });
        return { ok: true, intent, publicId, status: updated.status, replies: replies() };
      }
    } catch (e) {
      await wa.send({
        to: from,
        body: publicErrorMessage(e, waLocale),
        buttons: ["Status"],
      });
      return { ok: true, intent, error: publicErrorMessage(e, waLocale), replies: replies() };
    }
  }

  return { ok: true, intent, unhandled: true as const, replies: replies() };
}
