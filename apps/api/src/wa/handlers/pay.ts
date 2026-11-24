import { lineGatewayPaise } from "@localmeals/domain";
import { parsePayCommand } from "@localmeals/adapters";
import {
  findAwaitingPaymentByPublicId,
  findLatestAwaitingPayment,
  getCheckoutById,
} from "../../services/orders.js";
import { localizedDishName } from "@localmeals/i18n";
import type { WaSession } from "../session.js";

export async function handlePay(s: WaSession): Promise<object> {
  const { db, from, text, intent, wa, mobile, replies, waSafe, waLocale, wt } = s;

  if (intent === "PAY") {
    return await waSafe("PAY", async () => {
      const { publicId: payId, checkoutId: payCheckout } = parsePayCommand(text);
      if (payCheckout) {
        const checkout = await getCheckoutById(db, payCheckout);
        if (!checkout?.paymentUrl || checkout.status !== "AWAITING_PAYMENT") {
          await wa.send({
            to: from,
            body: wt("wa.noUnpaidCheckout", { id: payCheckout }),
            buttons: ["Orders", "Menu"],
          });
          return { ok: true, intent, empty: true, replies: replies() };
        }
        const { mobileOwnsOrder } = await import("../../http/orderOwnership.js");
        const seed = checkout.orders[0];
        if (!seed || !mobileOwnsOrder(seed, mobile)) {
          await wa.send({
            to: from,
            body: wt("wa.noUnpaidCheckout", { id: payCheckout }),
            buttons: ["Orders", "Menu"],
          });
          return { ok: true, intent, empty: true, replies: replies() };
        }
        await wa.send({
          to: from,
          body: [
            wt("wa.payWeekTitle", { id: checkout.checkoutId }),
            ...checkout.orders.map(
              (o) => `• ${o.serviceDate} · ${o.qty}× ${localizedDishName(waLocale, o)}`,
            ),
            wt("wa.payTotal", { amount: (checkout.totalPaise / 100).toFixed(0) }),
            checkout.paymentUrl,
            "",
            wt("wa.simConfirmPayShort"),
          ].join("\n"),
          buttons: [`Pay ${checkout.checkoutId}`, "Orders"],
        });
        return {
          ok: true,
          intent,
          checkoutId: checkout.checkoutId,
          gatewayTxnId: checkout.gatewayTxnId,
          paymentUrl: checkout.paymentUrl,
          replies: replies(),
        };
      }
      const pending = payId
        ? await findAwaitingPaymentByPublicId(db, mobile, payId)
        : await findLatestAwaitingPayment(db, mobile);
      if (!pending?.paymentUrl) {
        await wa.send({
          to: from,
          body: payId
            ? wt("wa.noUnpaidOrderId", { id: payId })
            : wt("wa.noUnpaidOrder"),
          buttons: ["Menu", "Orders"],
        });
        return { ok: true, intent, empty: true, replies: replies() };
      }
      const totalPaise = lineGatewayPaise(pending);
      const payTarget = pending.checkoutId ?? pending.publicId;
      await wa.send({
        to: from,
        body: [
          wt("wa.payTitle", { id: payTarget }),
          `${pending.qty}× ${localizedDishName(waLocale, pending)}`,
          wt("wa.payTotal", { amount: (totalPaise / 100).toFixed(0) }),
          pending.paymentUrl,
          "",
          wt("wa.simConfirmPay"),
        ].join("\n"),
        buttons: [`Pay ${payTarget}`, "Menu"],
      });
      return {
        ok: true,
        intent,
        publicId: pending.publicId,
        checkoutId: pending.checkoutId,
        gatewayTxnId: pending.gatewayTxnId,
        paymentUrl: pending.paymentUrl,
        replies: replies(),
      };
    });
  }

  return { ok: true, intent, unhandled: true as const, replies: replies() };
}
