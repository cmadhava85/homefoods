"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CancelOrderButton } from "@/components/CancelOrderButton";
import { RequireAuth } from "@/components/RequireAuth";
import { ReviewForm } from "@/components/ReviewForm";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { loadFeatureFlags } from "@/lib/features";
import { isExternalPaymentUrl, payPageHref } from "@/lib/payments";
import { customerStatusLabel, statusTone } from "@/lib/orderStatus";
import { localizedDishName, type MsgKey } from "@localmeals/i18n";
import { kitchenOrderHref } from "@/lib/kitchenHref";
import { kitchensBrowseHref } from "@/lib/soloKitchen";

type HistoryOrder = {
  id: number;
  publicId: string;
  checkoutId?: string | null;
  status: string;
  itemName: string;
  itemNameTa?: string | null;
  qty: number;
  spice: string;
  foodPaise?: number;
  foodDiscountPaise?: number;
  deliveryPaise?: number;
  platformFeePaise?: number;
  totalPaise: number;
  serviceDate: string;
  mealType?: string;
  deliveryTargetAddress: string;
  deliveryWindow?: string | null;
  kitchenName: string | null;
  cookSlug: string | null;
  logisticsMode?: string | null;
  kitchenDeliveryType?: string | null;
  partnerShipmentId?: string | null;
  partnerTrackingUrl?: string | null;
  canReorder?: boolean;
  paymentUrl?: string;
  gatewayTxnId?: string | null;
  cancellable?: boolean;
  cancelRequestable?: boolean;
  canReview?: boolean;
  hasReview?: boolean;
  childPays?: boolean;
  payerMobile?: string | null;
  roleOnOrder?: "CUSTOMER" | "PAYER";
  createdAt: string;
  ticket?: { id: number; status: string; decision: string | null } | null;
};

type ConcernCategory =
  | "QUALITY"
  | "FOODBORNE"
  | "WRONG_ITEM"
  | "MISSING_DELIVERY"
  | "DELAY"
  | "PAYMENT"
  | "OTHER";

type FilterTab = "open" | "past" | "all";

type ListItem =
  | { kind: "single"; order: HistoryOrder }
  | { kind: "week"; checkoutId: string; lines: HistoryOrder[] };

const CONCERN_CATEGORIES: ConcernCategory[] = [
  "QUALITY",
  "FOODBORNE",
  "WRONG_ITEM",
  "MISSING_DELIVERY",
  "DELAY",
  "PAYMENT",
  "OTHER",
];

const CONCERN_STATUSES = new Set([
  "PAID",
  "COOKING",
  "PACKED",
  "ASSIGNING_RIDER",
  "DISPATCHED",
  "DELIVERED",
  "DELAYED",
  "RETURNED_TO_KITCHEN",
  "LOGISTICS_EXCEPTION",
  "REFUNDED",
]);

const PAST_STATUSES = new Set([
  "DELIVERED",
  "REFUNDED",
  "CANCELLED",
  "RETURNED_TO_KITCHEN",
]);

function isOpenOrder(o: HistoryOrder) {
  if (o.canReview) return true;
  if (
    o.status === "AWAITING_PAYMENT" ||
    o.status === "CONFIRMING_PAYMENT" ||
    o.status === "FAILED" ||
    o.status === "CANCEL_REQUESTED" ||
    o.status === "PENDING_APPROVAL"
  ) {
    return true;
  }
  return !PAST_STATUSES.has(o.status);
}

function needsPay(o: HistoryOrder) {
  return (
    o.status === "AWAITING_PAYMENT" ||
    o.status === "CONFIRMING_PAYMENT" ||
    o.status === "FAILED"
  );
}

function mealLabel(mealType: string | undefined, t: (k: MsgKey) => string) {
  if (!mealType) return "";
  const key = `meal.${mealType.toLowerCase()}` as MsgKey;
  const label = t(key);
  return label === key ? mealType.toLowerCase() : label;
}

function buildListItems(orders: HistoryOrder[]): ListItem[] {
  const byCheckout = new Map<string, HistoryOrder[]>();
  for (const o of orders) {
    if (!o.checkoutId) continue;
    const list = byCheckout.get(o.checkoutId) ?? [];
    list.push(o);
    byCheckout.set(o.checkoutId, list);
  }

  const used = new Set<number>();
  const items: ListItem[] = [];
  for (const o of orders) {
    if (used.has(o.id)) continue;
    const group = o.checkoutId ? byCheckout.get(o.checkoutId) : null;
    if (group && group.length > 1) {
      for (const line of group) used.add(line.id);
      items.push({
        kind: "week",
        checkoutId: o.checkoutId!,
        lines: [...group].sort((a, b) => a.serviceDate.localeCompare(b.serviceDate)),
      });
    } else {
      used.add(o.id);
      items.push({ kind: "single", order: o });
    }
  }
  return items;
}

function OrdersInner() {
  const { t, locale } = useLocale();
  const statusOpts = (o: HistoryOrder) => ({
    childPays: o.childPays,
    roleOnOrder: o.roleOnOrder,
  });
  const [orders, setOrders] = useState<HistoryOrder[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterTab>("open");
  const [concernFor, setConcernFor] = useState<string | null>(null);
  const [concernCategory, setConcernCategory] = useState<ConcernCategory>("QUALITY");
  const [concernText, setConcernText] = useState("");
  const [concernPhotoUrl, setConcernPhotoUrl] = useState<string | null>(null);
  const [concernPhotoName, setConcernPhotoName] = useState<string | null>(null);
  const [leanWaStatus, setLeanWaStatus] = useState(false);
  const [leanWaPlatformOn, setLeanWaPlatformOn] = useState(false);
  const [savingLeanWa, setSavingLeanWa] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    authFetch("/me/orders")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load orders");
        setOrders(json.orders ?? []);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    authFetch("/me/profile")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) return;
        setLeanWaStatus(Boolean(json.leanWaStatus));
      })
      .catch(() => undefined);
    loadFeatureFlags()
      .then((flags) => {
        if (typeof flags.lean_wa_status_enabled === "boolean") {
          setLeanWaPlatformOn(Boolean(flags.lean_wa_status_enabled));
        }
      })
      .catch(() => undefined);
  }, []);

  async function toggleLeanWa() {
    setSavingLeanWa(true);
    setErr(null);
    try {
      const res = await authFetch("/me/profile", {
        method: "PATCH",
        body: JSON.stringify({ leanWaStatus: !leanWaStatus }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save preference");
      setLeanWaStatus(Boolean(json.leanWaStatus));
      setMsg(t("orders.leanWaSaved"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingLeanWa(false);
    }
  }

  async function uploadConcernPhoto(publicId: string, file: File) {
    setBusyId(`photo-${publicId}`);
    setErr(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await authFetch(`/orders/${publicId}/concern/photo`, {
        method: "POST",
        body,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Photo upload failed");
      setConcernPhotoUrl(json.url);
      setConcernPhotoName(file.name);
    } catch (e) {
      setErr((e as Error).message);
      setConcernPhotoUrl(null);
      setConcernPhotoName(null);
    } finally {
      setBusyId(null);
    }
  }

  async function submitConcern(publicId: string) {
    setBusyId(`concern-${publicId}`);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/orders/${publicId}/concern`, {
        method: "POST",
        body: JSON.stringify({
          category: concernCategory,
          summary: concernText.trim(),
          photoUrl: concernPhotoUrl,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not submit concern");
      setMsg(t("orders.concernOk", { id: json.ticketId }));
      setConcernFor(null);
      setConcernText("");
      setConcernCategory("QUALITY");
      setConcernPhotoUrl(null);
      setConcernPhotoName(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const filteredOrders = useMemo(() => {
    if (filter === "all") return orders;
    if (filter === "open") return orders.filter(isOpenOrder);
    return orders.filter((o) => !isOpenOrder(o));
  }, [orders, filter]);

  const listItems = useMemo(() => buildListItems(filteredOrders), [filteredOrders]);

  const openCount = orders.filter(isOpenOrder).length;
  const pastCount = orders.length - openCount;
  const payCount = orders.filter(needsPay).length;

  function payButton(o: HistoryOrder) {
    if (
      !(
        o.status === "AWAITING_PAYMENT" ||
        o.status === "CONFIRMING_PAYMENT" ||
        o.status === "FAILED"
      )
    ) {
      return null;
    }
    if (!(o.paymentUrl || o.gatewayTxnId || o.status === "FAILED")) return null;
    const label = o.status === "FAILED" ? t("pay.retry") : t("orders.payNow");
    if (isExternalPaymentUrl(o.paymentUrl)) {
      return (
        <a className="btn sm" href={o.paymentUrl}>
          {label}
        </a>
      );
    }
    return (
      <Link className="btn sm" href={payPageHref(o.checkoutId ?? o.publicId, o.gatewayTxnId)}>
        {label}
      </Link>
    );
  }

  function renderConcern(o: HistoryOrder) {
    if (concernFor !== o.publicId) return null;
    return (
      <div className="order-concern">
        <h3>{t("orders.concernTitle")}</h3>
        <label className="order-field">
          {t("orders.concernCategory")}
          <select
            value={concernCategory}
            onChange={(e) => setConcernCategory(e.target.value as ConcernCategory)}
            disabled={Boolean(busyId?.startsWith("concern-") || busyId?.startsWith("photo-"))}
          >
            {CONCERN_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`orders.cat.${c}` as MsgKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="order-field">
          {t("orders.concernDetails")}
          <textarea
            value={concernText}
            onChange={(e) => setConcernText(e.target.value)}
            placeholder={t("orders.concernPlaceholder")}
            rows={3}
            disabled={Boolean(busyId?.startsWith("concern-"))}
          />
        </label>
        <label className="order-field">
          {t("orders.concernPhoto")}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            disabled={Boolean(busyId)}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void uploadConcernPhoto(o.publicId, file);
            }}
          />
        </label>
        {busyId === `photo-${o.publicId}` ? (
          <p className="muted">{t("orders.concernPhotoUploading")}</p>
        ) : null}
        {concernPhotoUrl ? (
          <p className="ok">{t("orders.concernPhotoReady", { name: concernPhotoName ?? "photo" })}</p>
        ) : null}
        <div className="actions">
          <button
            className="btn sm"
            type="button"
            disabled={
              busyId === `concern-${o.publicId}` ||
              busyId === `photo-${o.publicId}` ||
              concernText.trim().length < 10
            }
            onClick={() => void submitConcern(o.publicId)}
          >
            {busyId === `concern-${o.publicId}`
              ? t("orders.concernSending")
              : t("orders.concernSubmit")}
          </button>
          <button
            className="btn sm secondary"
            type="button"
            disabled={Boolean(busyId)}
            onClick={() => setConcernFor(null)}
          >
            {t("orders.concernCancel")}
          </button>
        </div>
      </div>
    );
  }

  function formatServiceShort(iso: string) {
    const [, m, d] = iso.split("-");
    return `${Number(d)}/${Number(m)}`;
  }

  function renderOrderRow(o: HistoryOrder, opts?: { nested?: boolean }) {
    const primaryPay = payButton(o);
    const showConcern = CONCERN_STATUSES.has(o.status) && o.roleOnOrder !== "PAYER";
    const showReorder = o.canReorder && o.cookSlug && !primaryPay;
    return (
      <article
        key={o.id}
        className={`order-row${opts?.nested ? " order-row-nested" : ""}${
          needsPay(o) ? " order-row-urgent" : ""
        }`}
      >
        <div className="order-row-main">
          <div className="order-row-copy">
            <h2 className="order-row-title">
              <span className="order-row-qty">{o.qty}×</span>{" "}
              {localizedDishName(locale, o)}
            </h2>
            <p className="order-row-meta">
              <span className="order-row-kitchen">
                {o.kitchenName ?? t("orders.kitchenFallback")}
                {o.cookSlug ? (
                  <>
                    {" · "}
                    <Link href={`/kitchen/${o.cookSlug}`}>{t("orders.menuLink")}</Link>
                  </>
                ) : null}
              </span>
              <span className="order-row-when">
                {formatServiceShort(o.serviceDate)}
                {o.mealType ? ` · ${mealLabel(o.mealType, t)}` : ""}
                {o.deliveryWindow ? ` · ${o.deliveryWindow}` : ""}
              </span>
            </p>
            {o.roleOnOrder === "PAYER" ? (
              <p className="order-row-note">{t("orders.familyPayYou")}</p>
            ) : null}
            {o.childPays && o.roleOnOrder !== "PAYER" && o.payerMobile ? (
              <p className="order-row-note">
                {t("orders.childPaysLine", { mobile: o.payerMobile })}
              </p>
            ) : null}
            {o.kitchenDeliveryType === "PARTNER" ||
            o.logisticsMode === "PARTNER" ||
            o.status === "ASSIGNING_RIDER" ? (
              <p className="order-row-note">
                {o.status === "ASSIGNING_RIDER"
                  ? t("confirmed.partnerFinding")
                  : t("confirmed.deliveredByPartner")}
                {o.partnerShipmentId ? ` · ${o.partnerShipmentId}` : ""}
              </p>
            ) : null}
          </div>
          <div className="order-row-aside">
            <div className="order-row-price">₹{(o.totalPaise / 100).toFixed(0)}</div>
            <span className={`chip tone-${statusTone(o.status)}`}>
              {customerStatusLabel(t, o.status, statusOpts(o))}
            </span>
            {o.ticket ? (
              <span className="chip" title={o.ticket.decision ?? undefined}>
                Ticket #{o.ticket.id} · {o.ticket.status}
                {o.ticket.decision ? ` · ${o.ticket.decision}` : ""}
              </span>
            ) : null}
          </div>
        </div>

        <div className="order-row-actions">
          {primaryPay ? <div className="order-row-primary">{primaryPay}</div> : null}
          <div className="order-row-secondary">
            <Link className="order-action-link" href={`/order/confirmed/${o.publicId}`}>
              {t("common.details")}
            </Link>
            {showReorder ? (
              <Link
                className="order-action-link"
                href={kitchenOrderHref({
                  slug: o.cookSlug!,
                  mealType: o.mealType,
                  afterServiceDate: o.serviceDate,
                  again: true,
                })}
              >
                {t("orders.reorder")}
              </Link>
            ) : null}
            <CancelOrderButton
              publicId={o.publicId}
              paid={o.status === "PAID"}
              cancellable={o.cancellable}
              cancelRequestable={o.cancelRequestable}
              className="order-action-link"
              onDone={({ mode }) => {
                setMsg(
                  mode === "cancel_requested"
                    ? t("orders.cancelRequested", { id: o.publicId })
                    : mode === "refunded"
                      ? t("orders.refunded", { id: o.publicId })
                      : t("orders.cancelled", { id: o.publicId }),
                );
                load();
              }}
            />
            {o.status === "CANCEL_REQUESTED" ? (
              <span className="chip tone-warn">{t("orders.waitingKitchenCancel")}</span>
            ) : null}
            {showConcern ? (
              <button
                className="order-action-link"
                type="button"
                onClick={() => {
                  setConcernFor(concernFor === o.publicId ? null : o.publicId);
                  setConcernCategory("QUALITY");
                  setConcernText("");
                  setConcernPhotoUrl(null);
                  setConcernPhotoName(null);
                  setErr(null);
                }}
              >
                {t("orders.concern")}
              </button>
            ) : null}
          </div>
        </div>

        {renderConcern(o)}

        {o.canReview ? (
          <div className="order-row-extra">
            <ReviewForm compact publicId={o.publicId} onDone={load} />
          </div>
        ) : null}
        {o.hasReview ? <p className="muted order-row-note">{t("orders.reviewed")}</p> : null}
      </article>
    );
  }

  return (
    <main className="orders-page">
      <header className="orders-hero">
        <h1>{t("orders.title")}</h1>
        <p className="muted">{t("orders.blurbShort")}</p>
        {leanWaPlatformOn ? (
          <div className="order-lean-wa">
            <p className="muted" style={{ marginBottom: "0.35rem" }}>
              {t("orders.leanWaHelp")}
            </p>
            <button
              type="button"
              className="btn sm secondary"
              disabled={savingLeanWa}
              onClick={() => void toggleLeanWa()}
            >
              {leanWaStatus ? t("orders.leanWaOn") : t("orders.leanWaOff")}
            </button>
          </div>
        ) : null}
      </header>

      {orders.length > 0 ? (
        <div className="seg orders-filter" role="tablist" aria-label={t("orders.filter")}>
          <button
            type="button"
            className={filter === "open" ? "on" : ""}
            onClick={() => setFilter("open")}
          >
            {t("orders.filterOpen")}
            {openCount ? ` · ${openCount}` : ""}
          </button>
          <button
            type="button"
            className={filter === "past" ? "on" : ""}
            onClick={() => setFilter("past")}
          >
            {t("orders.filterPast")}
            {pastCount ? ` · ${pastCount}` : ""}
          </button>
          <button
            type="button"
            className={filter === "all" ? "on" : ""}
            onClick={() => setFilter("all")}
          >
            {t("orders.filterAll")}
          </button>
        </div>
      ) : null}

      {payCount > 0 && filter !== "past" ? (
        <p className="orders-pay-hint">{t("orders.payHint", { n: payCount })}</p>
      ) : null}

      {loading ? <p className="muted">{t("common.loading")}</p> : null}
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="ok">{msg}</p> : null}

      {!loading && !err && orders.length === 0 ? (
        <div className="orders-empty">
          <h2>{t("orders.emptyTitle")}</h2>
          <p className="muted">{t("orders.emptyBody")}</p>
          <Link className="btn" href={kitchensBrowseHref()}>
            {t("account.findKitchens")}
          </Link>
        </div>
      ) : null}

      {!loading && !err && orders.length > 0 && listItems.length === 0 ? (
        <p className="muted">{t("orders.filterEmpty")}</p>
      ) : null}

      <div className="orders-list">
        {listItems.map((item) => {
          if (item.kind === "single") {
            return renderOrderRow(item.order);
          }

          const { checkoutId, lines } = item;
          const weekTotal = lines.reduce((s, l) => s + l.totalPaise, 0);
          const weekCancellable = lines.some((l) => l.cancellable);
          const weekRequestable = lines.some((l) => l.cancelRequestable);
          const anyPay = lines.find(needsPay);

          return (
            <section key={`week-${checkoutId}`} className="order-week">
              <div className="order-week-head">
                <div>
                  <p className="order-week-kicker">{t("orders.weekCart")}</p>
                  <h2 className="order-week-title">
                    {t("orders.weekDays", { n: lines.length })}
                    {lines[0]?.kitchenName ? ` · ${lines[0].kitchenName}` : ""}
                  </h2>
                  <p className="order-row-meta">
                    {lines.map((l) => l.serviceDate.slice(5)).join(" · ")}
                  </p>
                </div>
                <div className="order-row-price">₹{(weekTotal / 100).toFixed(0)}</div>
              </div>
              <div className="order-row-actions order-week-actions">
                {anyPay ? <div className="order-row-primary">{payButton(anyPay)}</div> : null}
                <div className="order-row-secondary">
                  <Link className="order-action-link" href={`/order/confirmed/${checkoutId}`}>
                    {t("common.details")}
                  </Link>
                  <CancelOrderButton
                    checkoutId={checkoutId}
                    paid={lines.some((l) => l.status === "PAID")}
                    cancellable={weekCancellable}
                    cancelRequestable={weekRequestable}
                    className="order-action-link"
                    onDone={({ mode }) => {
                      setMsg(
                        mode === "cancel_requested"
                          ? t("orders.cancelRequested", { id: checkoutId })
                          : mode === "refunded"
                            ? t("orders.refunded", { id: checkoutId })
                            : t("orders.cancelled", { id: checkoutId }),
                      );
                      load();
                    }}
                  />
                </div>
              </div>
              <div className="order-week-days">
                {lines.map((line) => renderOrderRow(line, { nested: true }))}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

export default function OrdersPage() {
  return (
    <RequireAuth role="CUSTOMER">
      <OrdersInner />
    </RequireAuth>
  );
}
