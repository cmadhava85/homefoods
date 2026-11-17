"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { API_BASE } from "@/lib/api";
import { isExternalPaymentUrl } from "@/lib/payments";
import { localizedDishName } from "@localmeals/i18n";

type PayLine = {
  publicId: string;
  itemName: string;
  itemNameTa?: string | null;
  foodPaise: number;
  foodDiscountPaise?: number;
  deliveryPaise: number;
  platformFeePaise: number;
  qty: number;
  serviceDate?: string;
  status: string;
};

const PAID_LIKE = new Set([
  "PAID",
  "COOKING",
  "PACKED",
  "DISPATCHED",
  "DELAYED",
  "DELIVERED",
]);

const TERMINAL_UNPAID = new Set(["FAILED", "CANCELLED", "REFUNDED"]);

export default function PayPage() {
  const { publicId } = useParams<{ publicId: string }>();
  const search = useSearchParams();
  const txn = search.get("txn");
  const razorpayStatus = search.get("razorpay_payment_link_status");
  const razorpayPaymentId = search.get("razorpay_payment_id");
  const razorpayLinkId = search.get("razorpay_payment_link_id");
  const router = useRouter();
  const { t, locale } = useLocale();
  const [lines, setLines] = useState<PayLine[]>([]);
  const [checkoutId, setCheckoutId] = useState<string | null>(null);
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [waitingGateway, setWaitingGateway] = useState(false);
  const confirmStarted = useRef(false);

  const isCheckout = publicId.startsWith("CHK-");
  const external = isExternalPaymentUrl(paymentUrl);
  const mockMode =
    Boolean(txn?.startsWith("mock_")) ||
    (Boolean(paymentUrl) && !external && Boolean(txn));

  function goConfirmed(dest: string) {
    router.replace(`/order/confirmed/${dest}`);
  }

  useEffect(() => {
    let cancelled = false;
    const path = isCheckout ? `/checkouts/${publicId}` : `/orders/${publicId}`;

    async function load() {
      const r = await fetch(`${API_BASE}${path}`, { credentials: "include" });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? "Not found");
      if (cancelled) return;

      const nextStatus = json.status as string;
      setStatus(nextStatus);
      setPaymentUrl(typeof json.paymentUrl === "string" ? json.paymentUrl : null);

      if (isCheckout) {
        setCheckoutId(json.checkoutId);
        setLines(
          (json.orders as PayLine[]).map((o) => ({
            ...o,
            status: o.status,
          })),
        );
      } else {
        setCheckoutId(json.checkoutId ?? null);
        setLines([json as PayLine]);
      }

      if (PAID_LIKE.has(nextStatus)) {
        goConfirmed(json.checkoutId ?? publicId);
      }
    }

    load().catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per order id
  }, [publicId, isCheckout]);

  // After Razorpay return: confirm once via API, then short poll (do not restart on status).
  useEffect(() => {
    const returnedPaid =
      razorpayStatus === "paid" ||
      razorpayStatus === "partially_paid" ||
      Boolean(razorpayPaymentId?.startsWith("pay_"));
    if (!returnedPaid && status !== "CONFIRMING_PAYMENT") return;
    if (status && PAID_LIKE.has(status)) return;
    if (status && TERMINAL_UNPAID.has(status) && !returnedPaid) return;

    let cancelled = false;
    const path = isCheckout ? `/checkouts/${publicId}` : `/orders/${publicId}`;
    setWaitingGateway(true);

    async function confirmReturn() {
      if (!returnedPaid || confirmStarted.current) return;
      confirmStarted.current = true;
      try {
        const res = await fetch(`${API_BASE}/payments/confirm-return`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            publicId,
            // Gateway verifies status; do not trust client paymentId/linkStatus.
            paymentLinkId: razorpayLinkId ?? txn ?? undefined,
          }),
        });
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && json.ok && PAID_LIKE.has(json.status)) {
          goConfirmed(json.checkoutId ?? publicId);
          return;
        }
        if (json.status) setStatus(json.status);
        if (!res.ok && json.error) {
          setError(String(json.error));
        }
      } catch {
        if (!cancelled) {
          setError(
            "Couldn’t confirm payment with the server. Check your connection — we’ll keep checking.",
          );
        }
      }
    }

    void confirmReturn();

    let attempts = 0;
    let pollFailures = 0;
    const id = window.setInterval(async () => {
      attempts += 1;
      if (attempts > 15 || cancelled) {
        window.clearInterval(id);
        if (!cancelled) {
          setWaitingGateway(false);
          setError(
            (prev) =>
              prev ??
              "We couldn’t confirm payment yet. If UPI was deducted, tap “I already paid” or open My orders.",
          );
        }
        return;
      }
      try {
        const r = await fetch(`${API_BASE}${path}`, { credentials: "include" });
        const json = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          pollFailures += 1;
          if (pollFailures >= 3) {
            setError(json.error ?? "Couldn’t refresh payment status");
          }
          return;
        }
        pollFailures = 0;
        setStatus(json.status);
        if (PAID_LIKE.has(json.status)) {
          window.clearInterval(id);
          goConfirmed(json.checkoutId ?? publicId);
          return;
        }
        if (TERMINAL_UNPAID.has(json.status) && !returnedPaid) {
          window.clearInterval(id);
          setWaitingGateway(false);
        }
      } catch {
        pollFailures += 1;
        if (!cancelled && pollFailures >= 3) {
          setError("Network issue while checking payment — retry in a moment.");
        }
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
    // Intentionally omit `status` — including it restarted the interval forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    razorpayStatus,
    razorpayPaymentId,
    razorpayLinkId,
    publicId,
    isCheckout,
  ]);

  async function confirmPay() {
    if (!txn) return;
    setConfirming(true);
    setError(null);
    const res = await fetch(`${API_BASE}/payments/mock-confirm`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gatewayTxnId: txn }),
    });
    const data = await res.json();
    setConfirming(false);
    if (!res.ok) {
      setError(data.error ?? "Payment failed");
      return;
    }
    const dest = checkoutId ?? data.checkoutId ?? publicId;
    router.push(`/order/confirmed/${dest}`);
  }

  if (!lines.length) {
    if (error) return <p className="err">{error}</p>;
    return <p className="muted">{t("common.loading")}</p>;
  }

  const total = lines.reduce(
    (s, o) =>
      s +
      Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0)) +
      o.deliveryPaise +
      o.platformFeePaise,
    0,
  );

  const unpaidTerminal = status != null && TERMINAL_UNPAID.has(status);

  const foodGross = lines.reduce((s, o) => s + o.foodPaise * o.qty, 0);
  const deliverySub = lines.reduce((s, o) => s + o.deliveryPaise, 0);
  const platformSub = lines.reduce((s, o) => s + o.platformFeePaise, 0);
  const discountSub = lines.reduce((s, o) => s + (o.foodDiscountPaise ?? 0), 0);

  return (
    <main className="card pay-panel">
      <h1>
        {t("pay.title")} {checkoutId ? `· ${checkoutId}` : publicId}
      </h1>
      {error ? <p className="err">{error}</p> : null}
      {mockMode ? (
        <p className="pay-mock-banner" role="status">
          {t("pay.mockBanner")}
        </p>
      ) : null}
      {status === "FAILED" ? <p className="err">{t("pay.failed")}</p> : null}
      {lines.map((o) => (
        <div key={o.publicId} className="row">
          <span>
            {o.serviceDate ? `${o.serviceDate} · ` : ""}
            {o.qty}× {localizedDishName(locale, o)}
          </span>
          <strong>
            ₹
            {(
              (Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0)) +
                o.deliveryPaise +
                o.platformFeePaise) /
              100
            ).toFixed(0)}
          </strong>
        </div>
      ))}
      <div className="row">
        <span>{t("pay.food")}</span>
        <strong>₹{(foodGross / 100).toFixed(0)}</strong>
      </div>
      {discountSub > 0 ? (
        <div className="row">
          <span>{t("cart.weekOff", { amount: (discountSub / 100).toFixed(0) })}</span>
          <strong>−₹{(discountSub / 100).toFixed(0)}</strong>
        </div>
      ) : null}
      <div className="row">
        <span>{t("pay.delivery")}</span>
        <strong>₹{(deliverySub / 100).toFixed(0)}</strong>
      </div>
      <div className="row">
        <span>{t("pay.platform")}</span>
        <strong>₹{(platformSub / 100).toFixed(0)}</strong>
      </div>
      <div className="row pay-total-row">
        <span>{t("pay.total")}</span>
        <strong>₹{(total / 100).toFixed(0)}</strong>
      </div>
      <p className="muted" style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
        {t("pay.cookGets")}
      </p>
      <div className="actions pay-actions">
        {waitingGateway ? (
          <p className="muted">{t("pay.confirming")}</p>
        ) : unpaidTerminal && external && paymentUrl ? (
          <>
            <p className="err">{t("pay.notConfirmed")}</p>
            <button
              className="btn"
              type="button"
              onClick={() => {
                confirmStarted.current = false;
                setWaitingGateway(true);
                void fetch(`${API_BASE}/payments/confirm-return`, {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    publicId,
                    paymentLinkId: razorpayLinkId ?? txn ?? undefined,
                  }),
                })
                  .then((r) => r.json())
                  .then((json) => {
                    if (json.ok && PAID_LIKE.has(json.status)) {
                      goConfirmed(json.checkoutId ?? publicId);
                    } else {
                      setWaitingGateway(false);
                      setStatus(json.status ?? status);
                      if (json.error) setError(String(json.error));
                      else {
                        setError(t("pay.pollTimeout"));
                      }
                    }
                  })
                  .catch(() => {
                    setWaitingGateway(false);
                    setError(t("pay.network"));
                  });
              }}
            >
              {t("pay.alreadyPaid")}
            </button>
            <a className="btn secondary" href={paymentUrl}>
              {t("pay.openAgain")}
            </a>
          </>
        ) : external && paymentUrl ? (
          <a className="btn" href={paymentUrl}>
            {status === "FAILED"
              ? t("pay.retry")
              : t("pay.upiCta", { amount: (total / 100).toFixed(0) })}
          </a>
        ) : mockMode ? (
          <button
            className="btn mustard"
            type="button"
            onClick={confirmPay}
            disabled={!txn || confirming}
          >
            {confirming
              ? t("pay.confirming")
              : t("pay.mockCta", { amount: (total / 100).toFixed(0) })}
          </button>
        ) : (
          <p className="muted">
            <a href="/orders">{t("orders.title")}</a>
          </p>
        )}
      </div>
    </main>
  );
}
