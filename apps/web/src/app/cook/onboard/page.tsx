"use client";

import Link from "next/link";
import { useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { API_BASE } from "@/lib/api";
import { localeHeaders } from "@/lib/locale";

type ApplyResult = {
  ok: true;
  slugHandle: string;
  kitchenName: string;
  onboardingStatus: string;
  message: string;
};

const STANDARD_KEYS = [
  "onboard.stdHygiene",
  "onboard.stdTaste",
  "onboard.stdHygieneRefund",
  "onboard.stdPlatform",
  "onboard.stdPause",
  "onboard.stdCutoff",
  "onboard.stdPhotos",
] as const;

export default function CookOnboardPage() {
  const { t } = useLocale();
  const [mobile, setMobile] = useState("");
  const [kitchenName, setKitchenName] = useState("");
  const [pinCode, setPinCode] = useState("600119");
  const [fssaiNumber, setFssaiNumber] = useState("");
  const [payoutUpiId, setPayoutUpiId] = useState("");
  const [payoutAccountNote, setPayoutAccountNote] = useState("");
  const [pickupLandmark, setPickupLandmark] = useState("");
  const [acceptedStandards, setAcceptedStandards] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ApplyResult | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!acceptedStandards) {
      setErr(t("onboard.acceptRequired"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/cooks/apply`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...localeHeaders() },
        body: JSON.stringify({
          mobile,
          kitchenName,
          pinCode,
          fssaiNumber: fssaiNumber.trim() || null,
          payoutUpiId: payoutUpiId.trim() || null,
          payoutAccountNote: payoutAccountNote.trim() || null,
          pickupLandmark: pickupLandmark.trim() || null,
          acceptedKitchenStandards: true,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? t("onboard.errorGeneric"));
      setDone(json as ApplyResult);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="card login-panel onboard-panel">
        <p className="chip">{t("onboard.chipDone")}</p>
        <h1 style={{ fontSize: "1.55rem" }}>{t("onboard.thanksTitle")}</h1>
        <p className="muted">{done.message || t("onboard.thanksBody")}</p>
        <p className="ok" style={{ marginTop: "0.75rem" }}>
          {t("onboard.slugLabel")}: /{done.slugHandle}
        </p>
        <p className="muted" style={{ marginTop: "0.5rem" }}>
          {t("onboard.nextSteps")}
        </p>
        <div className="actions">
          <Link className="btn" href="/login?role=cook">
            {t("onboard.cookLogin")}
          </Link>
          <Link className="btn secondary" href="/">
            {t("onboard.home")}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="card login-panel onboard-panel">
      <p className="chip">{t("onboard.chip")}</p>
      <h1 style={{ fontSize: "1.55rem" }}>{t("onboard.title")}</h1>
      <p className="muted">{t("onboard.blurb")}</p>
      <ul className="onboard-points muted">
        <li>{t("onboard.pointFssai")}</li>
        <li>{t("onboard.pointPayout")}</li>
        <li>{t("onboard.pointNoAadhaar")}</li>
      </ul>

      <section className="onboard-standards" aria-labelledby="onboard-standards-title">
        <h2 id="onboard-standards-title" className="onboard-standards-title">
          {t("onboard.standardsTitle")}
        </h2>
        <p className="muted">{t("onboard.standardsLead")}</p>
        <ul className="onboard-points">
          {STANDARD_KEYS.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
      </section>

      <form onSubmit={submit} style={{ marginTop: "1rem" }}>
        <label className="order-field">
          {t("onboard.mobile")}
          <input
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            placeholder="+91…"
            autoComplete="tel"
            required
            disabled={busy}
          />
        </label>
        <label className="order-field" style={{ marginTop: "0.65rem" }}>
          {t("onboard.kitchenName")}
          <input
            value={kitchenName}
            onChange={(e) => setKitchenName(e.target.value)}
            placeholder={t("onboard.kitchenPlaceholder")}
            required
            disabled={busy}
          />
        </label>
        <label className="order-field" style={{ marginTop: "0.65rem" }}>
          {t("onboard.pin")}
          <input
            value={pinCode}
            onChange={(e) => setPinCode(e.target.value)}
            inputMode="numeric"
            maxLength={6}
            required
            disabled={busy}
          />
        </label>
        <label className="order-field" style={{ marginTop: "0.65rem" }}>
          {t("onboard.fssai")}
          <input
            value={fssaiNumber}
            onChange={(e) => setFssaiNumber(e.target.value)}
            placeholder={t("onboard.fssaiPlaceholder")}
            inputMode="numeric"
            disabled={busy}
          />
        </label>
        <label className="order-field" style={{ marginTop: "0.65rem" }}>
          {t("onboard.upi")}
          <input
            value={payoutUpiId}
            onChange={(e) => setPayoutUpiId(e.target.value)}
            placeholder="name@upi"
            disabled={busy}
          />
        </label>
        <label className="order-field" style={{ marginTop: "0.65rem" }}>
          {t("onboard.bankNote")}
          <input
            value={payoutAccountNote}
            onChange={(e) => setPayoutAccountNote(e.target.value)}
            placeholder={t("onboard.bankPlaceholder")}
            disabled={busy}
          />
        </label>
        <label className="order-field" style={{ marginTop: "0.65rem" }}>
          {t("onboard.landmark")}
          <input
            value={pickupLandmark}
            onChange={(e) => setPickupLandmark(e.target.value)}
            placeholder={t("onboard.landmarkPlaceholder")}
            disabled={busy}
          />
        </label>

        <label className="onboard-accept">
          <input
            type="checkbox"
            checked={acceptedStandards}
            onChange={(e) => setAcceptedStandards(e.target.checked)}
            disabled={busy}
            required
          />
          <span>{t("onboard.acceptLabel")}</span>
        </label>

        {err ? <p className="err" style={{ marginTop: "0.75rem" }}>{err}</p> : null}

        <div className="actions" style={{ marginTop: "1rem" }}>
          <button className="btn" type="submit" disabled={busy || !acceptedStandards}>
            {busy ? t("onboard.submitting") : t("onboard.submit")}
          </button>
          <Link className="btn secondary" href="/login?role=cook">
            {t("onboard.alreadyCook")}
          </Link>
        </div>
      </form>
    </main>
  );
}
