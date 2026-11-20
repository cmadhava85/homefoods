"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { CancelOrderButton } from "@/components/CancelOrderButton";
import { ReviewForm } from "@/components/ReviewForm";
import { useLocale } from "@/components/LocaleProvider";
import {
  customerStatusBlurb,
  customerStatusHeadline,
  customerStatusLabel,
  progressSteps,
  statusTone,
} from "@/lib/orderStatus";
import { kitchenOrderHref } from "@/lib/kitchenHref";
import { isSoloKitchenMode } from "@/lib/soloKitchen";
import { localizedDishName, type MsgKey } from "@localmeals/i18n";

export type ConfirmedOrderView = {
  publicId: string;
  itemName: string;
  itemNameTa?: string | null;
  qty: number;
  status: string;
  foodPaise: number;
  foodDiscountPaise?: number | null;
  weekDiscountPercent?: number | null;
  deliveryPaise: number;
  platformFeePaise: number;
  gatewayTxnId: string | null;
  deliveryTargetAddress: string;
  serviceDate: string;
  mealType?: string;
  kitchenName?: string | null;
  cookSlug?: string | null;
  canReorder?: boolean;
  deliveryWindow?: string | null;
  fulfillmentMode?: string | null;
  logisticsMode?: string | null;
  kitchenDeliveryType?: string | null;
  partnerShipmentId?: string | null;
  partnerTrackingUrl?: string | null;
  pickup?: {
    fulfillmentMode: "PICKUP";
    landmark: string | null;
    pickupCode: string;
    revealAfterPay: boolean;
  } | null;
  cancellable?: boolean;
  cancelRequestable?: boolean;
  checkoutId?: string | null;
  paymentUrl?: string;
  canReview?: boolean;
  hasReview?: boolean;
  review?: { rating: number; comment: string | null; cookReply: string | null } | null;
  payerMobile?: string | null;
  awaitingFamilyPay?: boolean;
  roleOnOrder?: "CUSTOMER" | "PAYER" | null;
};

export type ConfirmedCheckoutView = {
  checkoutId: string;
  status: string;
  gatewayTxnId: string | null;
  paymentUrl?: string;
  totalPaise: number;
  kitchenName: string | null;
  cookSlug: string | null;
  cancellable?: boolean;
  cancelRequestable?: boolean;
  orders: ConfirmedOrderView[];
  awaitingFamilyPay?: boolean;
  payerMobile?: string | null;
};

function mealTitle(
  t: (key: MsgKey, params?: Record<string, string | number>) => string,
  mealType?: string,
) {
  const key =
    mealType === "BREAKFAST"
      ? "meal.breakfast"
      : mealType === "DINNER"
        ? "meal.dinner"
        : "meal.lunch";
  return t(key);
}

function formatServiceDate(iso: string, locale: string) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(locale === "ta" ? "ta-IN" : "en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(d);
}

function lineTotal(o: {
  foodPaise: number;
  deliveryPaise: number;
  platformFeePaise: number;
  qty: number;
  foodDiscountPaise?: number | null;
}) {
  const food = Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0));
  return food + o.deliveryPaise + o.platformFeePaise;
}

/** One status signal: progress track on kitchen path; banner only for exceptions. */
function OrderProgress({
  status,
  childPays,
  fulfillmentMode,
  logisticsMode,
}: {
  status: string;
  childPays?: boolean;
  fulfillmentMode?: string | null;
  logisticsMode?: string | null;
}) {
  const { t } = useLocale();
  const tone = statusTone(status);
  const steps = progressSteps(t, status, fulfillmentMode, logisticsMode);
  const showTrack = steps.some((s) => s.state !== "idle");
  const statusOpts = { childPays, roleOnOrder: "CUSTOMER" as const, fulfillmentMode };
  // Banner only when track isn't carrying the message (pay/cancel/fail/etc.).
  const showBanner = !showTrack || tone === "warn" || tone === "bad";

  const bannerClass =
    tone === "bad"
      ? "err confirm-banner"
      : tone === "warn"
        ? "ok status-banner warn confirm-banner"
        : "ok status-banner confirm-banner";

  return (
    <div className="confirm-progress">
      {showBanner ? (
        status === "REFUNDED" ? (
          <div className={`${bannerClass} confirm-refund-note`} role="status">
            <strong className="confirm-refund-title">{t("status.blurb.refundedTitle")}</strong>
            <p className="confirm-refund-body">{t("status.blurb.refunded")}</p>
          </div>
        ) : (
          <p className={bannerClass} role="status">
            {customerStatusBlurb(t, status, statusOpts)}
          </p>
        )
      ) : null}
      {showTrack ? (
        <ol className="status-track" aria-label={t("confirmed.progress")}>
          {steps.map((s) => (
            <li key={s.key} className={`status-track-step ${s.state}`}>
              <span className="status-track-dot" />
              <span className="status-track-label">{s.label}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="confirm-detail-row">
      <span className="confirm-detail-label">{label}</span>
      <div className="confirm-detail-value">{children}</div>
    </div>
  );
}

/** Guest signup seeds primaryAddress as "Address on file"; treat as unset. */
function formatDeliveryAddress(
  raw: string | null | undefined,
  t: (key: MsgKey, params?: Record<string, string | number>) => string,
) {
  const addr = (raw ?? "").trim();
  if (!addr) return t("confirmed.addressOnFile");
  if (/^address on file/i.test(addr)) return t("confirmed.addressPlaceholder");
  return addr;
}

export function ConfirmedCheckoutClient({ checkout }: { checkout: ConfirmedCheckoutView }) {
  const { t, locale } = useLocale();
  const solo = isSoloKitchenMode();
  const foodPaise = checkout.orders.reduce(
    (s, o) => s + Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0)),
    0,
  );
  const deliveryPaise = checkout.orders.reduce((s, o) => s + o.deliveryPaise, 0);
  const platformPaise = checkout.orders.reduce((s, o) => s + o.platformFeePaise, 0);

  return (
    <main className="confirm-stage">
      <section className="card confirm-panel">
        <header className="confirm-header">
          {checkout.kitchenName ? (
            <p className="confirm-kicker">
              {checkout.cookSlug ? (
                <Link href={`/kitchen/${checkout.cookSlug}`}>
                  {t("confirmed.fromKitchen", { name: checkout.kitchenName })}
                </Link>
              ) : (
                t("confirmed.fromKitchen", { name: checkout.kitchenName })
              )}
            </p>
          ) : null}
          <h1>{t("confirmed.weekOrder")}</h1>
          <p className="confirm-ref">{t("confirmed.ref", { id: checkout.checkoutId })}</p>
        </header>

        {checkout.awaitingFamilyPay && checkout.payerMobile ? (
          <p className="muted confirm-note">
            {t("confirmed.childPaysBlurb", { mobile: checkout.payerMobile })}
          </p>
        ) : null}

        <OrderProgress status={checkout.status} />

        <div className="confirm-receipt">
          <h2 className="confirm-section-title">{t("confirmed.details")}</h2>
          <ul className="confirm-lines">
            {checkout.orders.map((o) => (
              <li key={o.publicId} className="confirm-line">
                <div className="confirm-line-copy">
                  <span className="confirm-line-meta">
                    {mealTitle(t, o.mealType)} · {formatServiceDate(o.serviceDate, locale)}
                    {o.status === "CANCELLED" ? t("confirmed.cancelledSuffix") : ""}
                  </span>
                  <span className="confirm-line-name">
                    {o.qty}× {localizedDishName(locale, o)}
                  </span>
                </div>
                <span className="confirm-line-price">₹{(lineTotal(o) / 100).toFixed(0)}</span>
              </li>
            ))}
          </ul>

          <div className="confirm-summary">
            {deliveryPaise > 0 ? (
              <DetailRow label={t("pay.delivery")}>₹{(deliveryPaise / 100).toFixed(0)}</DetailRow>
            ) : null}
            {!solo && platformPaise > 0 ? (
              <DetailRow label={t("pay.platform")}>₹{(platformPaise / 100).toFixed(0)}</DetailRow>
            ) : null}
            {deliveryPaise > 0 || (!solo && platformPaise > 0) ? (
              <DetailRow label={t("pay.food")}>₹{(foodPaise / 100).toFixed(0)}</DetailRow>
            ) : null}
            <div className="confirm-total-row">
              <span>{t("confirmed.total")}</span>
              <strong>₹{(checkout.totalPaise / 100).toFixed(0)}</strong>
            </div>
          </div>
        </div>

        <div className="actions confirm-actions">
          <Link className="btn" href="/orders">
            {t("orders.title")}
          </Link>
          <CancelOrderButton
            checkoutId={checkout.checkoutId}
            cancellable={checkout.cancellable}
            cancelRequestable={checkout.cancelRequestable}
          />
          <Link
            className="btn secondary"
            href={
              checkout.cookSlug
                ? kitchenOrderHref({
                    slug: checkout.cookSlug,
                    mealType: checkout.orders[0]?.mealType,
                    afterServiceDate: checkout.orders
                      .map((o) => o.serviceDate)
                      .sort()
                      .at(-1),
                    again: true,
                  })
                : "/discover"
            }
          >
            {t("confirmed.orderAgain")}
          </Link>
        </div>
      </section>
    </main>
  );
}

export function ConfirmedOrderClient({ order }: { order: ConfirmedOrderView }) {
  const { t, locale } = useLocale();
  const total = lineTotal(order);
  const solo = isSoloKitchenMode();
  const pending = order.status === "PENDING_APPROVAL";
  const childPays =
    order.awaitingFamilyPay === true ||
    (Boolean(order.payerMobile) &&
      (order.status === "AWAITING_PAYMENT" || order.status === "CONFIRMING_PAYMENT") &&
      order.roleOnOrder !== "PAYER");
  const statusOpts = {
    childPays,
    roleOnOrder: (order.roleOnOrder ?? "CUSTOMER") as "CUSTOMER" | "PAYER",
    fulfillmentMode: order.fulfillmentMode,
  };
  const foodNet = Math.max(0, order.foodPaise * order.qty - (order.foodDiscountPaise ?? 0));
  const showPartner =
    order.kitchenDeliveryType === "PARTNER" ||
    order.logisticsMode === "PARTNER" ||
    order.status === "ASSIGNING_RIDER";
  const showHowDelivered = !solo && order.fulfillmentMode !== "PICKUP";

  return (
    <main className="confirm-stage">
      <section className="card confirm-panel">
        <header className="confirm-header">
          {order.kitchenName ? (
            <p className="confirm-kicker">
              {order.cookSlug ? (
                <Link href={`/kitchen/${order.cookSlug}`}>
                  {t("confirmed.fromKitchen", { name: order.kitchenName })}
                </Link>
              ) : (
                t("confirmed.fromKitchen", { name: order.kitchenName })
              )}
            </p>
          ) : null}
          <h1>{customerStatusHeadline(t, order.status, statusOpts)}</h1>
          <p className="confirm-ref">{t("confirmed.ref", { id: order.publicId })}</p>
        </header>

        {pending ? <p className="muted confirm-note">{t("confirmed.pendingBlurb")}</p> : null}
        {childPays && order.payerMobile ? (
          <p className="muted confirm-note">
            {t("confirmed.childPaysBlurb", { mobile: order.payerMobile })}
          </p>
        ) : null}

        <OrderProgress
          status={order.status}
          childPays={childPays}
          fulfillmentMode={order.fulfillmentMode}
          logisticsMode={order.logisticsMode}
        />

        <div className="confirm-hero-meal">
          <p className="confirm-hero-meta">
            {mealTitle(t, order.mealType)} · {formatServiceDate(order.serviceDate, locale)}
            {order.deliveryWindow ? ` · ${order.deliveryWindow}` : ""}
          </p>
          <p className="confirm-hero-name">
            {order.qty}× {localizedDishName(locale, order)}
          </p>
        </div>

        <div className="confirm-receipt">
          <h2 className="confirm-section-title">{t("confirmed.details")}</h2>
          {order.fulfillmentMode === "PICKUP" ? (
            <>
              <DetailRow label={t("confirmed.pickupCode")}>
                {order.pickup?.pickupCode ?? order.publicId}
              </DetailRow>
              <DetailRow label={t("confirmed.landmark")}>
                {order.pickup?.landmark ? order.pickup.landmark : t("confirmed.afterPay")}
              </DetailRow>
              {order.deliveryWindow ? (
                <DetailRow label={t("confirmed.pickupWindow")}>{order.deliveryWindow}</DetailRow>
              ) : null}
            </>
          ) : (
            <>
              <DetailRow label={t("confirmed.deliverTo")}>
                {formatDeliveryAddress(order.deliveryTargetAddress, t)}
              </DetailRow>
              {showHowDelivered ? (
                <DetailRow label={t("confirmed.howDelivered")}>
                  {order.kitchenDeliveryType === "PARTNER" || order.logisticsMode === "PARTNER"
                    ? t("confirmed.deliveredByPartner")
                    : t("confirmed.deliveredByCook")}
                </DetailRow>
              ) : null}
            </>
          )}

          {showPartner ? (
            <div className="partner-logistics-card">
              <DetailRow label={t("confirmed.partnerLogistics")}>
                {order.status === "ASSIGNING_RIDER"
                  ? t("confirmed.partnerFinding")
                  : order.partnerShipmentId
                    ? customerStatusLabel(t, order.status, statusOpts)
                    : t("confirmed.deliveredByPartner")}
              </DetailRow>
              {order.partnerShipmentId ? (
                <DetailRow label={t("confirmed.shipmentId", { id: order.partnerShipmentId })}>
                  {order.partnerTrackingUrl ? (
                    <a href={order.partnerTrackingUrl} target="_blank" rel="noreferrer">
                      {t("confirmed.partnerTrack")}
                    </a>
                  ) : (
                    "—"
                  )}
                </DetailRow>
              ) : null}
            </div>
          ) : null}

          <div className="confirm-summary">
            {order.deliveryPaise > 0 ? (
              <DetailRow label={t("pay.delivery")}>
                ₹{(order.deliveryPaise / 100).toFixed(0)}
              </DetailRow>
            ) : null}
            {!solo && order.platformFeePaise > 0 ? (
              <DetailRow label={t("pay.platform")}>
                ₹{(order.platformFeePaise / 100).toFixed(0)}
              </DetailRow>
            ) : null}
            {order.deliveryPaise > 0 || (!solo && order.platformFeePaise > 0) ? (
              <DetailRow label={t("pay.food")}>
                ₹{(foodNet / 100).toFixed(0)}
                {order.weekDiscountPercent ? ` (−${order.weekDiscountPercent}%)` : ""}
              </DetailRow>
            ) : null}
            <div className="confirm-total-row">
              <span>{t("confirmed.total")}</span>
              <strong>₹{(total / 100).toFixed(0)}</strong>
            </div>
          </div>
        </div>

        <p className="confirm-help muted">{t("confirmed.wrongAddress")}</p>

        {order.canReview ? (
          <div className="confirm-review">
            <ReviewForm publicId={order.publicId} />
          </div>
        ) : null}
        {order.hasReview && order.review ? (
          <p className="muted confirm-note">
            {t("confirmed.yourRating")} {"★".repeat(order.review.rating)}
            {order.review.cookReply
              ? ` · ${t("confirmed.cookReplied")} ${order.review.cookReply}`
              : ""}
          </p>
        ) : null}

        <div className="actions confirm-actions">
          <Link className="btn" href="/orders">
            {t("orders.title")}
          </Link>
          <CancelOrderButton
            publicId={order.publicId}
            cancellable={order.cancellable}
            cancelRequestable={order.cancelRequestable}
          />
          <Link
            className="btn secondary"
            href={
              order.cookSlug
                ? kitchenOrderHref({
                    slug: order.cookSlug,
                    mealType: order.mealType,
                    afterServiceDate: order.serviceDate,
                    again: true,
                  })
                : "/discover"
            }
          >
            {t("confirmed.orderAgain")}
          </Link>
        </div>
      </section>
    </main>
  );
}
