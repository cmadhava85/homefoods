"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { cateringStatusKey, type CateringBooking } from "@/lib/catering";
import { formatInr } from "@/lib/money";

function BookingInner() {
  const { publicId } = useParams<{ publicId: string }>();
  const search = useSearchParams();
  const { t } = useLocale();
  const [booking, setBooking] = useState<CateringBooking | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Back from the gateway (Razorpay adds razorpay_payment_link_*; mock adds ?txn=) → re-verify server-side.
  const returning = Boolean(search.get("txn") || search.get("razorpay_payment_link_id"));

  const load = useCallback(
    async (confirm: boolean) => {
      setErr(null);
      try {
        const res = await authFetch(
          `/catering/bookings/${publicId}${confirm ? "/confirm" : ""}`,
          confirm ? { method: "POST", body: "{}" } : {},
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? t("cat.loadFailed"));
        setBooking(json.booking as CateringBooking);
      } catch (e) {
        setErr((e as Error).message);
      }
    },
    [publicId, t],
  );

  useEffect(() => {
    void load(returning);
  }, [load, returning]);

  async function pay() {
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(`/catering/bookings/${publicId}/pay`, { method: "POST", body: "{}" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Payment link failed");
      window.location.href = json.paymentUrl as string;
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function cancel() {
    if (!confirm(t("cat.cancelConfirm"))) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(`/catering/bookings/${publicId}/cancel`, { method: "POST", body: "{}" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Cancel failed");
      setBooking(json.booking as CateringBooking);
      setMsg(t("cat.cancelled"));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!booking) return <main className="content-stage">{err ? <p className="err">{err}</p> : <p className="muted">{returning ? t("cat.checking") : "…"}</p>}</main>;
  const b = booking;

  return (
    <main className="content-stage">
      <p>
        <Link href={`/kitchen/${b.kitchenSlug}/party`}>← {b.kitchenName}</Link>
      </p>
      <h1>{t("cat.booking", { id: b.publicId })}</h1>
      <p>
        <span className="chip">{t(cateringStatusKey(b.status))}</span>
      </p>
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="ok">{msg}</p> : null}

      <section className="card">
        <strong>
          {b.plates}× {b.comboName}
        </strong>
        {b.comboContents ? <p className="muted" style={{ margin: "0.35rem 0" }}>{b.comboContents}</p> : null}
        <p>{t("cat.when", { date: b.eventDate, time: b.eventTime })}</p>
        {b.fulfillmentMode === "PICKUP" ? (
          b.pickupLandmark ? <p>{t("cat.pickupAt", { landmark: b.pickupLandmark })}</p> : null
        ) : b.deliveryAddress ? (
          <p className="muted">
            {t("cat.deliverTo")}: {b.deliveryAddress}
          </p>
        ) : null}
        {b.note ? <p className="muted">“{b.note}”</p> : null}
      </section>

      <section className="card">
        <dl className="muted">
          <div className="row">
            <dt>{t("cat.food", { plates: b.plates, price: formatInr(b.pricePerPlatePaise) })}</dt>
            <dd>{formatInr(b.foodPaise)}</dd>
          </div>
          {b.platformFeePaise > 0 ? (
            <div className="row">
              <dt>{t("cat.fee")}</dt>
              <dd>{formatInr(b.platformFeePaise)}</dd>
            </div>
          ) : null}
          <div className="row">
            <dt>
              <strong>{t("cat.total")}</strong>
            </dt>
            <dd>
              <strong>{formatInr(b.totalPaise)}</strong>
            </dd>
          </div>
          <div className="row">
            <dt>{t("cat.paid")}</dt>
            <dd>{formatInr(b.paidPaise)}</dd>
          </div>
          {b.refundedPaise > 0 ? (
            <div className="row">
              <dt>{t("cat.refunded")}</dt>
              <dd>{formatInr(b.refundedPaise)}</dd>
            </div>
          ) : null}
        </dl>

        {b.duePhase ? (
          <button type="button" className="btn" disabled={busy} onClick={pay}>
            {b.duePhase === "ADVANCE"
              ? t("cat.payAdvance", { amount: formatInr(b.duePaise) })
              : t("cat.payBalance", { amount: formatInr(b.duePaise) })}
          </button>
        ) : null}
      </section>

      {b.canCustomerCancel ? (
        <section className="card">
          <p className="muted">
            {t("cat.cutoffNote", { time: new Date(b.cutoffAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) })}
          </p>
          <button type="button" className="btn sm secondary" disabled={busy} onClick={cancel}>
            {t("cat.cancel")}
          </button>
        </section>
      ) : null}
    </main>
  );
}

export default function CateringBookingPage() {
  return (
    <RequireAuth role="CUSTOMER">
      <Suspense fallback={<p className="muted">…</p>}>
        <BookingInner />
      </Suspense>
    </RequireAuth>
  );
}
