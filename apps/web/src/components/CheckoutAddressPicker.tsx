"use client";

import { useState } from "react";
import { authFetch } from "@/lib/auth";
import { useLocale } from "@/components/LocaleProvider";
import { validateAddressLine, validatePin } from "@localmeals/i18n";

export type SavedAddress = {
  id: number;
  label: string;
  line1: string;
  line2?: string | null;
  pinCode: string;
  lat?: string | number | null;
  lng?: string | number | null;
  isDefault: boolean;
};

type Label = "HOME" | "OFFICE" | "OTHER";

function readDeviceLocation(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  });
}

export function CheckoutAddressPicker({
  addresses,
  addressId,
  onChange,
  onCreated,
  required,
  compact = false,
}: {
  addresses: SavedAddress[];
  addressId: string;
  onChange: (id: string) => void;
  onCreated: (addr: SavedAddress) => void;
  required: boolean;
  /** Keep add-form closed until tapped so kitchen menu stays above the fold. */
  compact?: boolean;
}) {
  const { t } = useLocale();
  const [showAdd, setShowAdd] = useState(!compact && addresses.length === 0);
  const [label, setLabel] = useState<Label>("HOME");
  const [line1, setLine1] = useState("");
  const [pinCode, setPinCode] = useState("600119");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ line?: string; pin?: string }>({});

  async function captureLocation() {
    setLocating(true);
    setErr(null);
    try {
      const next = await readDeviceLocation();
      setCoords(next);
      if (!next) setErr(t("address.locationHint"));
    } finally {
      setLocating(false);
    }
  }

  async function saveNew() {
    const lineKey = validateAddressLine(line1);
    const pinKey = validatePin(pinCode);
    setFieldErr({
      line: lineKey ? t(lineKey) : undefined,
      pin: pinKey ? t(pinKey) : undefined,
    });
    if (lineKey || pinKey) return;

    setBusy(true);
    setErr(null);
    try {
      // Prefer already-captured GPS; otherwise try once (deny = still save with PIN centre).
      const geo = coords ?? (await readDeviceLocation());
      const res = await authFetch("/me/addresses", {
        method: "POST",
        body: JSON.stringify({
          label,
          line1,
          pinCode,
          isDefault: addresses.length === 0,
          ...(geo ? { lat: geo.lat, lng: geo.lng } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save address");
      onCreated(json as SavedAddress);
      onChange(String(json.id));
      setShowAdd(false);
      setLine1("");
      setCoords(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save address");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`checkout-address${compact ? " is-compact" : ""}`}>
      {addresses.length > 0 ? (
        <label className="checkout-address-label muted">
          {t("address.deliverTo")}
          {required ? " *" : ""}
          <select
            value={addressId}
            onChange={(e) => onChange(e.target.value)}
            required={required}
          >
            <option value="">{t("address.choose")}</option>
            {addresses.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} — {a.line1}
                {a.pinCode ? ` · ${a.pinCode}` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : !showAdd ? (
        <div className="checkout-address-empty">
          <span className="muted">
            {t("address.deliverTo")}
            {required ? " *" : ""}
          </span>
          <button className="btn sm" type="button" onClick={() => setShowAdd(true)}>
            {t("address.add")}
          </button>
        </div>
      ) : null}
      {!showAdd && addresses.length > 0 ? (
        <button
          className="btn sm secondary checkout-address-add-btn"
          type="button"
          onClick={() => setShowAdd(true)}
        >
          {t("address.add")}
        </button>
      ) : null}
      {showAdd ? (
        <div className="checkout-address-add">
          <div className="field-row checkout-address-add-row">
            <select
              value={label}
              onChange={(e) => setLabel(e.target.value as Label)}
              aria-label={t("address.label")}
            >
              <option value="HOME">{t("address.home")}</option>
              <option value="OFFICE">{t("address.office")}</option>
              <option value="OTHER">{t("address.other")}</option>
            </select>
            <input
              type="text"
              value={pinCode}
              onChange={(e) => setPinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder={t("address.pin")}
              inputMode="numeric"
              aria-label={t("address.pin")}
              aria-invalid={Boolean(fieldErr.pin)}
            />
          </div>
          {fieldErr.pin ? <p className="err">{fieldErr.pin}</p> : null}
          <input
            type="text"
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
            placeholder={t("address.line")}
            aria-label={t("address.line")}
            aria-invalid={Boolean(fieldErr.line)}
          />
          {fieldErr.line ? <p className="err">{fieldErr.line}</p> : null}
          <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
            {t("address.locationHint")}
            {coords ? ` · ✓ ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}` : ""}
          </p>
          <div className="checkout-address-add-actions">
            <button
              className="btn sm secondary"
              type="button"
              disabled={locating || busy}
              onClick={() => void captureLocation()}
            >
              {locating ? t("address.locating") : t("address.useLocation")}
            </button>
            <button
              className="btn sm secondary"
              type="button"
              onClick={() => {
                setShowAdd(false);
                setErr(null);
                setFieldErr({});
                setCoords(null);
              }}
            >
              {t("address.cancel")}
            </button>
            <button
              className="btn sm"
              type="button"
              disabled={busy || line1.trim().length < 5 || pinCode.length !== 6}
              onClick={() => void saveNew()}
            >
              {busy ? t("address.saving") : t("address.save")}
            </button>
          </div>
        </div>
      ) : null}
      {err ? <p className="err">{err}</p> : null}
    </div>
  );
}
