"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { cateringStatusKey, type CateringBooking } from "@/lib/catering";
import { formatInr } from "@/lib/money";

type AdminBooking = CateringBooking & {
  commissionBps: number;
  commissionPaise: number;
  cookPayoutPaise: number;
  cookPaidAt: string | null;
  cookPaidUtr: string | null;
  payments: Array<{ id: number; phase: string; amountPaise: number; status: string; method: string }>;
};

/** Admin → Party orders: advance/balance/refund rows, cancel with refund, manual pay, cook payout. */
export function CateringAdminPanel() {
  const { t } = useLocale();
  const [bookings, setBookings] = useState<AdminBooking[]>([]);
  const [platformEnabled, setPlatformEnabled] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authFetch("/admin/catering/bookings?limit=100");
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? t("cat.loadFailed"));
    setBookings(json.bookings as AdminBooking[]);
    setPlatformEnabled(Boolean(json.platformEnabled));
  }, [t]);

  useEffect(() => {
    load().catch((e) => setErr((e as Error).message));
  }, [load]);

  async function act(publicId: string, path: string, body: Record<string, unknown>) {
    setBusy(publicId);
    setErr(null);
    try {
      const res = await authFetch(`/admin/catering/bookings/${publicId}/${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function cancel(b: AdminBooking) {
    const reason = prompt(t("cat.admin.reasonPrompt"));
    if (!reason || reason.trim().length < 3) return;
    const raw = prompt(t("cat.admin.refundPrompt"), "");
    if (raw === null) return;
    const rupees = raw.trim() === "" ? null : Number(raw);
    if (rupees !== null && !(rupees >= 0)) return;
    void act(b.publicId, "cancel", {
      reason: reason.trim(),
      ...(rupees !== null ? { refundPaise: Math.round(rupees * 100) } : {}),
    });
  }

  function manualPay(b: AdminBooking) {
    const reference = prompt(t("cat.admin.utrPrompt"));
    if (reference && reference.trim().length >= 3) void act(b.publicId, "manual-payment", { reference: reference.trim() });
  }

  function cookPaid(b: AdminBooking) {
    const utr = prompt(t("cat.admin.utrPrompt"));
    if (utr && utr.trim().length >= 4) void act(b.publicId, "cook-paid", { utr: utr.trim() });
  }

  return (
    <section>
      <h2>{t("cat.admin.title")}</h2>
      {!platformEnabled ? <p className="muted">{t("cat.admin.flagOff")}</p> : null}
      {err ? <p className="err">{err}</p> : null}
      {bookings.length === 0 ? <p className="muted">{t("cat.desk.none")}</p> : null}
      {bookings.map((b) => {
        const open = b.status === "AWAITING_ADVANCE" || b.status === "ADVANCE_PAID" || b.status === "PAID";
        return (
          <div key={b.publicId} className="card">
            <div className="row">
              <strong>
                {b.publicId} · {b.kitchenName} · {b.plates}× {b.comboName}
              </strong>
              <span className="chip">{t(cateringStatusKey(b.status))}</span>
            </div>
            <p className="muted">
              {t("cat.when", { date: b.eventDate, time: b.eventTime })} · {b.customerMobile ?? "—"}
            </p>
            <p className="muted">
              {t("cat.total")} {formatInr(b.totalPaise)} · {t("cat.paid")} {formatInr(b.paidPaise)} ·{" "}
              {t("cat.refunded")} {formatInr(b.refundedPaise)}
              {b.cookPaidAt ? ` · ${t("cat.admin.cookPaid")} ${b.cookPaidUtr ?? ""}` : ""}
            </p>
            <p className="muted">
              {t("admin.commission")} ({b.commissionBps / 100}%) −{formatInr(b.commissionPaise)} ·{" "}
              {t("admin.cookPayout")} <strong>{formatInr(b.cookPayoutPaise)}</strong>
            </p>
            <ul className="muted" style={{ margin: "0.25rem 0 0.5rem", paddingLeft: "1.1rem" }}>
              {b.payments.map((p) => (
                <li key={p.id}>
                  {p.phase} · {formatInr(p.amountPaise)} · {p.status} · {p.method}
                </li>
              ))}
            </ul>
            <div className="row" style={{ justifyContent: "flex-start", gap: "0.5rem", flexWrap: "wrap" }}>
              {b.duePhase ? (
                <button type="button" className="btn sm secondary" disabled={busy === b.publicId} onClick={() => manualPay(b)}>
                  {t("cat.admin.manualPay")}
                </button>
              ) : null}
              {open ? (
                <button type="button" className="btn sm secondary" disabled={busy === b.publicId} onClick={() => cancel(b)}>
                  {t("cat.admin.cancel")}
                </button>
              ) : null}
              {b.status === "COMPLETED" && !b.cookPaidAt ? (
                <button type="button" className="btn sm" disabled={busy === b.publicId} onClick={() => cookPaid(b)}>
                  {t("cat.admin.markCookPaid")}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
