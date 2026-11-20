"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch, loginPath } from "@/lib/auth";
import { needsCheckoutAddress, type FulfillmentMode } from "@/lib/fulfillment";
import { isExternalPaymentUrl, payPageHref } from "@/lib/payments";
import { localizedDishName } from "@localmeals/i18n";

export type CartAddPayload = {
  menuItemId: number;
  itemName: string;
  itemNameTa?: string | null;
  serviceDate: string;
  pricePaise: number;
  qty: number;
  spice: "NORMAL" | "LESS";
};

export function OrderForm({
  cookSlug,
  menuItemId,
  itemName,
  itemNameTa,
  serviceDate,
  pricePaise,
  orderingOpen = true,
  onAddToCart,
  confirmBeforeOrder,
  addressId,
  needsAddress = true,
  fulfillmentMode = "DELIVERY",
  payerMobile = null,
}: {
  cookSlug: string;
  menuItemId: number;
  itemName: string;
  itemNameTa?: string | null;
  serviceDate: string;
  pricePaise?: number;
  orderingOpen?: boolean;
  /** When set and ordering is open, primary action adds to week cart instead of paying now. */
  onAddToCart?: (line: CartAddPayload) => void;
  /** Soft gate when customer already has an order that day. */
  confirmBeforeOrder?: () => boolean;
  /** Selected saved address — required for delivery / late. */
  addressId?: string;
  needsAddress?: boolean;
  fulfillmentMode?: FulfillmentMode;
  payerMobile?: string | null;
}) {
  const router = useRouter();
  const { user, ready } = useAuth();
  const { t, locale } = useLocale();
  const dish = localizedDishName(locale, { itemName, itemNameTa });
  const [qty, setQty] = useState(1);
  const [spice, setSpice] = useState<"NORMAL" | "LESS">("NORMAL");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const useCart = Boolean(onAddToCart) && orderingOpen;

  async function submitInstant() {
    if (!user || user.role !== "CUSTOMER") {
      router.push(loginPath("CUSTOMER", `/kitchen/${cookSlug}`));
      return;
    }
    if (needsAddress && !addressId) {
      setError(t("address.chooseFirst"));
      return;
    }
    if (confirmBeforeOrder && !confirmBeforeOrder()) return;
    setLoading(true);
    setError(null);
    try {
      const path = orderingOpen ? "/orders" : "/orders/late-request";
      const res = await authFetch(path, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          customerMobile: user.mobile,
          cookSlug,
          menuItemId,
          qty,
          spice,
          serviceDate,
          fulfillmentMode,
          payerMobile: payerMobile || null,
          addressId:
            needsCheckoutAddress(fulfillmentMode) && addressId ? Number(addressId) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");

      if (!orderingOpen || data.status === "PENDING_APPROVAL") {
        router.push(`/order/confirmed/${data.publicId}`);
        return;
      }
      if (isExternalPaymentUrl(data.paymentUrl)) {
        window.location.href = data.paymentUrl as string;
        return;
      }
      router.push(payPageHref(data.publicId, data.gatewayTxnId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setLoading(false);
    }
  }

  function addToCart() {
    if (!user || user.role !== "CUSTOMER") {
      router.push(loginPath("CUSTOMER", `/kitchen/${cookSlug}`));
      return;
    }
    if (!onAddToCart || pricePaise == null) return;
    setError(null);
    onAddToCart({
      menuItemId,
      itemName,
      itemNameTa,
      serviceDate,
      pricePaise,
      qty,
      spice,
    });
  }

  if (ready && (!user || user.role !== "CUSTOMER")) {
    return (
      <p className="muted order-signin">
        <Link href={loginPath("CUSTOMER", `/kitchen/${cookSlug}`)}>{t("order.signIn")}</Link>
        {t("order.signInTo", { item: dish, date: serviceDate })}
      </p>
    );
  }

  return (
    <div className="order-actions">
      <div className="order-controls">
        <div className="order-field">
          <span>{t("order.qty")}</span>
          <div className="qty-stepper" role="group" aria-label={t("order.qty")}>
            <button
              type="button"
              className="qty-stepper-btn"
              aria-label="−"
              disabled={qty <= 1}
              onClick={() => setQty((q) => Math.max(1, q - 1))}
            >
              −
            </button>
            <span className="qty-stepper-value" aria-live="polite">
              {qty}
            </span>
            <button
              type="button"
              className="qty-stepper-btn"
              aria-label="+"
              onClick={() => setQty((q) => Math.min(20, q + 1))}
            >
              +
            </button>
          </div>
        </div>
        <label className="order-field order-field-grow">
          <span>{t("order.spice")}</span>
          <select value={spice} onChange={(e) => setSpice(e.target.value as "NORMAL" | "LESS")}>
            <option value="NORMAL">{t("order.spiceNormal")}</option>
            <option value="LESS">{t("order.spiceLess")}</option>
          </select>
        </label>
      </div>
      <div className="order-ctas">
        {useCart ? (
          <button className="btn mustard order-cta-primary" type="button" disabled={!ready} onClick={addToCart}>
            {t("order.addWeek")}
          </button>
        ) : null}
        <button
          className={useCart ? "btn secondary order-cta-secondary" : "btn order-cta-primary"}
          type="button"
          disabled={loading || !ready}
          onClick={submitInstant}
        >
          {loading
            ? orderingOpen
              ? t("order.creating")
              : t("order.requesting")
            : orderingOpen
              ? useCart
                ? t("order.thisDayOnly")
                : t("order.forDate", { date: serviceDate })
              : t("order.late")}
        </button>
      </div>
      {!orderingOpen ? <p className="muted order-note">{t("order.lateNote")}</p> : null}
      {error ? <p className="err">{error}</p> : null}
    </div>
  );
}
