"use client";

import Link from "next/link";
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

function StatusBanner({
  status,
  childPays,
  fulfillmentMode,
}: {
  status: string;
  childPays?: boolean;
  fulfillmentMode?: string | null;
}) {
  const { t } = useLocale();
  const tone = statusTone(status);
  const bannerClass =
    tone === "bad" ? "err" : tone === "warn" ? "ok status-banner warn" : "ok status-banner";
  const steps = progressSteps(t, status, fulfillmentMode);
  const showTrack = steps.some((s) => s.state !== "idle");
  const statusOpts = { childPays, roleOnOrder: "CUSTOMER" as const, fulfillmentMode };

  return (
    <>
      <p className={bannerClass}>{customerStatusBlurb(t, status, statusOpts)}</p>
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
    </>
  );
}

export function ConfirmedCheckoutClient({ checkout }: { checkout: ConfirmedCheckoutView }) {
  const { t, locale } = useLocale();

  return (
    <main className="card confirm-panel">
      <StatusBanner status={checkout.status} />
      <h1>{t("confirmed.weekOrder")}</h1>
      <div className="row">
        <span>{t("confirmed.checkout")}</span>
        <strong>{checkout.checkoutId}</strong>
      </div>
      {checkout.kitchenName ? (
        <div className="row">
          <span>{t("confirmed.kitchen")}</span>
          <strong>
            {checkout.cookSlug ? (
              <Link href={`/kitchen/${checkout.cookSlug}`}>{checkout.kitchenName}</Link>
            ) : (
              checkout.kitchenName
            )}
          </strong>
        </div>
      ) : null}
      {checkout.orders.map((o) => (
        <div key={o.publicId} className="row">
          <span>
            {o.serviceDate} · {mealTitle(t, o.mealType)} · {o.qty}×{" "}
            {localizedDishName(locale, o)}
            {o.status === "CANCELLED"
              ? t("confirmed.cancelledSuffix")
              : ` · ${customerStatusLabel(t, o.status)}`}
          </span>
          <strong>₹{(lineTotal(o) / 100).toFixed(0)}</strong>
        </div>
      ))}
      <div className="row">
        <span>{t("pay.food")}</span>
        <strong>
          ₹
          {(
            checkout.orders.reduce(
              (s, o) => s + Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0)),
              0,
            ) / 100
          ).toFixed(0)}
        </strong>
      </div>
      <div className="row">
        <span>{t("pay.delivery")}</span>
        <strong>
          ₹{(checkout.orders.reduce((s, o) => s + o.deliveryPaise, 0) / 100).toFixed(0)}
        </strong>
      </div>
      <div className="row">
        <span>{t("pay.platform")}</span>
        <strong>
          ₹{(checkout.orders.reduce((s, o) => s + o.platformFeePaise, 0) / 100).toFixed(0)}
        </strong>
      </div>
      <div className="row">
        <span>{t("confirmed.total")}</span>
        <strong>₹{(checkout.totalPaise / 100).toFixed(2)}</strong>
      </div>
      <div className="actions">
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
          href={checkout.cookSlug ? `/kitchen/${checkout.cookSlug}` : "/discover"}
        >
          {t("confirmed.orderAgain")}
        </Link>
      </div>
    </main>
  );
}

export function ConfirmedOrderClient({ order }: { order: ConfirmedOrderView }) {
  const { t, locale } = useLocale();
  const total = lineTotal(order);
  const pending = order.status === "PENDING_APPROVAL";
  const childPays =
    Boolean(order.payerMobile) &&
    (order.status === "AWAITING_PAYMENT" || order.status === "CONFIRMING_PAYMENT");
  const statusOpts = {
    childPays,
    roleOnOrder: "CUSTOMER" as const,
    fulfillmentMode: order.fulfillmentMode,
  };

  return (
    <main className="card confirm-panel">
      <StatusBanner
        status={order.status}
        childPays={childPays}
        fulfillmentMode={order.fulfillmentMode}
      />
      <h1>{customerStatusHeadline(t, order.status, statusOpts)}</h1>
      {pending ? <p className="muted">{t("confirmed.pendingBlurb")}</p> : null}
      {childPays && order.payerMobile ? (
        <p className="muted">{t("confirmed.childPaysBlurb", { mobile: order.payerMobile })}</p>
      ) : null}
      <div className="row">
        <span>{t("confirmed.id")}</span>
        <strong>{order.publicId}</strong>
      </div>
      {order.kitchenName ? (
        <div className="row">
          <span>{t("confirmed.kitchen")}</span>
          <strong>
            {order.cookSlug ? (
              <Link href={`/kitchen/${order.cookSlug}`}>{order.kitchenName}</Link>
            ) : (
              order.kitchenName
            )}
          </strong>
        </div>
      ) : null}
      <div className="row">
        <span>{t("confirmed.meal")}</span>
        <strong>
          {order.qty}× {localizedDishName(locale, order)}
        </strong>
      </div>
      <div className="row">
        <span>{t("confirmed.for")}</span>
        <strong>
          {mealTitle(t, order.mealType)} · {order.serviceDate}
        </strong>
      </div>
      {order.fulfillmentMode === "PICKUP" ? null : (
        <div className="row">
          <span>{t("confirmed.deliverTo")}</span>
          <strong style={{ textAlign: "right", maxWidth: "65%" }}>
            {order.deliveryTargetAddress || t("confirmed.addressOnFile")}
          </strong>
        </div>
      )}
      {order.deliveryWindow ? (
        <div className="row">
          <span>
            {order.fulfillmentMode === "PICKUP"
              ? t("confirmed.pickupWindow")
              : t("confirmed.window")}
          </span>
          <strong>{order.deliveryWindow}</strong>
        </div>
      ) : null}
      {order.fulfillmentMode === "PICKUP" ? (
        <>
          <div className="row">
            <span>{t("confirmed.pickupCode")}</span>
            <strong>{order.pickup?.pickupCode ?? order.publicId}</strong>
          </div>
          <div className="row">
            <span>{t("confirmed.landmark")}</span>
            <strong style={{ textAlign: "right", maxWidth: "65%" }}>
              {order.pickup?.landmark ? order.pickup.landmark : t("confirmed.afterPay")}
            </strong>
          </div>
        </>
      ) : null}
      <div className="row">
        <span>{t("confirmed.status")}</span>
        <strong>
          <span className={`chip tone-${statusTone(order.status)}`}>
            {customerStatusLabel(t, order.status, statusOpts)}
          </span>
        </strong>
      </div>
      <div className="row">
        <span>{t("pay.food")}</span>
        <strong>
          ₹
          {(
            Math.max(0, order.foodPaise * order.qty - (order.foodDiscountPaise ?? 0)) / 100
          ).toFixed(0)}
          {order.weekDiscountPercent ? ` (−${order.weekDiscountPercent}%)` : ""}
        </strong>
      </div>
      <div className="row">
        <span>{t("pay.delivery")}</span>
        <strong>₹{(order.deliveryPaise / 100).toFixed(0)}</strong>
      </div>
      <div className="row">
        <span>{t("pay.platform")}</span>
        <strong>₹{(order.platformFeePaise / 100).toFixed(0)}</strong>
      </div>
      <div className="row">
        <span>{t("confirmed.total")}</span>
        <strong>₹{(total / 100).toFixed(2)}</strong>
      </div>
      <p className="muted" style={{ marginTop: "0.85rem", fontSize: "0.88rem" }}>
        {t("confirmed.wrongAddress")}
      </p>
      {order.canReview ? (
        <div style={{ marginTop: "1rem" }}>
          <ReviewForm publicId={order.publicId} />
        </div>
      ) : null}
      {order.hasReview && order.review ? (
        <p className="muted" style={{ marginTop: "0.85rem" }}>
          {t("confirmed.yourRating")} {"★".repeat(order.review.rating)}
          {order.review.cookReply
            ? ` · ${t("confirmed.cookReplied")} ${order.review.cookReply}`
            : ""}
        </p>
      ) : null}
      <div className="actions">
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
          href={order.cookSlug ? `/kitchen/${order.cookSlug}` : "/discover"}
        >
          {t("confirmed.orderAgain")}
        </Link>
      </div>
    </main>
  );
}
