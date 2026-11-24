"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CreditPanel } from "@/components/CreditPanel";
import { DeleteAccountPanel } from "@/components/DeleteAccountPanel";
import { RequireAuth } from "@/components/RequireAuth";
import { useAuth } from "@/components/AuthProvider";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch, setSession, type AuthUser } from "@/lib/auth";
import {
  validateAddressLine,
  validateFullName,
  validatePin,
  type MsgKey,
} from "@localmeals/i18n";
import { isSoloKitchenMode, kitchensBrowseHref } from "@/lib/soloKitchen";

type Profile = {
  mobile: string;
  fullName: string;
  pinCode: string;
  needsName: boolean;
  addresses: Array<{
    id: number;
    label: string;
    line1: string;
    line2?: string | null;
    pinCode: string;
    isDefault: boolean;
  }>;
};

type AddrLabel = "HOME" | "OFFICE" | "OTHER";

function labelKey(label: string): MsgKey {
  if (label === "HOME") return "account.labelHome";
  if (label === "OFFICE") return "account.labelOffice";
  return "account.labelOther";
}

function AccountInner() {
  const { user, setUser } = useAuth();
  const { t } = useLocale();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [fullName, setFullName] = useState("");
  const [pinCode, setPinCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ name?: string; pin?: string }>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAddAddr, setShowAddAddr] = useState(false);
  const [addrLabel, setAddrLabel] = useState<AddrLabel>("HOME");
  const [addrLine1, setAddrLine1] = useState("");
  const [addrLine2, setAddrLine2] = useState("");
  const [addrPin, setAddrPin] = useState("600119");
  const [addrBusy, setAddrBusy] = useState(false);
  const [addrFieldErr, setAddrFieldErr] = useState<{ line?: string; pin?: string }>({});

  const load = useCallback(() => {
    authFetch("/me/profile")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Could not load profile");
        setProfile(json as Profile);
        setFullName(json.fullName === "Guest" ? "" : json.fullName);
        const pin = json.pinCode ?? "600119";
        setPinCode(pin);
        setAddrPin((prev) => (prev === "600119" || !prev ? pin : prev));
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveAddress() {
    const lineKey = validateAddressLine(addrLine1);
    const pinKey = validatePin(addrPin);
    setAddrFieldErr({
      line: lineKey ? t(lineKey) : undefined,
      pin: pinKey ? t(pinKey) : undefined,
    });
    if (lineKey || pinKey) return;
    setAddrBusy(true);
    setErr(null);
    setMsg(null);
    try {
      let geo: { lat: number; lng: number } | null = null;
      if (typeof navigator !== "undefined" && navigator.geolocation) {
        geo = await new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (pos) =>
              resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
          );
        });
      }
      const res = await authFetch("/me/addresses", {
        method: "POST",
        body: JSON.stringify({
          label: addrLabel,
          line1: addrLine1.trim(),
          line2: addrLine2.trim() || null,
          pinCode: addrPin.trim(),
          isDefault: !(profile?.addresses?.length),
          ...(geo ? { lat: geo.lat, lng: geo.lng } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save address");
      setMsg(t("account.addressSaved"));
      setShowAddAddr(false);
      setAddrLine1("");
      setAddrLine2("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAddrBusy(false);
    }
  }

  async function setDefaultAddress(id: number) {
    setAddrBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/me/addresses/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isDefault: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not update");
      setMsg(t("account.defaultUpdated"));
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAddrBusy(false);
    }
  }

  async function save() {
    const nameKey = validateFullName(fullName);
    const pinKey = validatePin(pinCode);
    setFieldErr({
      name: nameKey ? t(nameKey) : undefined,
      pin: pinKey ? t(pinKey) : undefined,
    });
    if (nameKey || pinKey) return;

    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch("/me/profile", {
        method: "PATCH",
        body: JSON.stringify({
          fullName: fullName.trim() || undefined,
          pinCode: pinCode.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save");
      setMsg(t("account.saved"));
      setProfile((p) =>
        p
          ? {
              ...p,
              fullName: json.fullName,
              pinCode: json.pinCode,
              needsName: json.needsName,
            }
          : p,
      );
      try {
        localStorage.setItem("lm_pin", json.pinCode);
      } catch {
        /* ignore */
      }
      if (user) {
        const next: AuthUser = { ...user, fullName: json.fullName, pinCode: json.pinCode };
        setSession(null, next);
        setUser(next);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const browseHref = kitchensBrowseHref();
  const browseLabel = isSoloKitchenMode() ? t("account.backToKitchen") : t("account.findKitchens");
  const mobile = profile?.mobile ?? user?.mobile ?? "";
  const displayName =
    fullName.trim() ||
    (profile?.fullName && profile.fullName !== "Guest" ? profile.fullName : null);

  if (!profile && !err) {
    return (
      <main className="account-page">
        <p className="muted">{t("common.loading")}</p>
      </main>
    );
  }

  return (
    <main className="account-page">
      <header className="account-hero">
        <p className="account-kicker">{mobile}</p>
        <h1>{t("account.title")}</h1>
        {displayName ? (
          <p className="account-hello">{t("account.hello", { name: displayName })}</p>
        ) : (
          <p className="account-lead">{t("account.blurb")}</p>
        )}
      </header>

      {err ? <p className="err account-flash">{err}</p> : null}
      {msg ? <p className="ok account-flash">{msg}</p> : null}

      {profile?.needsName ? (
        <p className="ok status-banner warn account-flash" role="status">
          {t("account.needsName")}
        </p>
      ) : null}

      <section className="account-panel" aria-labelledby="account-profile-heading">
        <div className="account-panel-head">
          <h2 id="account-profile-heading">{t("account.profile")}</h2>
          <p className="account-panel-sub">{t("account.profileHelp")}</p>
        </div>

        <div className="account-fields">
          <label className="account-field account-field-span">
            <span className="account-field-label">{t("account.fullName")}</span>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder={t("account.fullName")}
              autoComplete="name"
              aria-invalid={Boolean(fieldErr.name)}
            />
            {fieldErr.name ? <span className="err account-field-err">{fieldErr.name}</span> : null}
          </label>

          <label className="account-field">
            <span className="account-field-label">{t("account.pin")}</span>
            <input
              type="text"
              inputMode="numeric"
              value={pinCode}
              onChange={(e) => setPinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="600119"
              autoComplete="postal-code"
              aria-invalid={Boolean(fieldErr.pin)}
              aria-describedby="account-pin-help"
            />
            <span id="account-pin-help" className="account-field-hint">
              {t("account.pinHelp")}
            </span>
            {fieldErr.pin ? <span className="err account-field-err">{fieldErr.pin}</span> : null}
          </label>
        </div>

        <div className="account-panel-actions">
          <button
            className="btn"
            type="button"
            disabled={busy || fullName.trim().length < 2 || pinCode.length !== 6}
            onClick={save}
          >
            {busy ? t("account.saving") : t("account.saveProfile")}
          </button>
        </div>
      </section>

      <section className="account-panel" aria-labelledby="account-addresses-heading">
        <div className="account-panel-head">
          <h2 id="account-addresses-heading">{t("account.addresses")}</h2>
          <p className="account-panel-sub">{t("account.addressesHelp")}</p>
        </div>

        {!profile?.addresses?.length ? (
          <div className="account-empty">
            <p className="account-empty-title">{t("account.noAddresses")}</p>
            <p className="account-empty-body">{t("account.noAddressesHint")}</p>
          </div>
        ) : (
          <ul className="account-address-list">
            {profile.addresses.map((a) => (
              <li key={a.id} className={`account-address${a.isDefault ? " is-default" : ""}`}>
                <div className="account-address-body">
                  <div className="account-address-meta">
                    <span className="account-address-label">{t(labelKey(a.label))}</span>
                    {a.isDefault ? (
                      <span className="account-address-badge">{t("account.defaultBadge")}</span>
                    ) : null}
                  </div>
                  <p className="account-address-line">{a.line1}</p>
                  {a.line2 ? <p className="account-address-line muted">{a.line2}</p> : null}
                  <p className="account-address-pin">PIN {a.pinCode}</p>
                </div>
                {!a.isDefault ? (
                  <button
                    className="btn sm secondary account-set-default"
                    type="button"
                    disabled={addrBusy}
                    onClick={() => void setDefaultAddress(a.id)}
                  >
                    {t("account.setDefault")}
                  </button>
                ) : (
                  <span className="account-default-hint">{t("account.usedAtCheckout")}</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {showAddAddr ? (
          <div className="account-add-address">
            <h3 className="account-add-title">{t("account.addAddress")}</h3>
            <div className="account-label-pills" role="group" aria-label={t("account.addressLabel")}>
              {(
                [
                  ["HOME", "account.labelHome"],
                  ["OFFICE", "account.labelOffice"],
                  ["OTHER", "account.labelOther"],
                ] as const
              ).map(([value, key]) => (
                <button
                  key={value}
                  type="button"
                  className={`account-label-pill${addrLabel === value ? " is-active" : ""}`}
                  aria-pressed={addrLabel === value}
                  onClick={() => setAddrLabel(value)}
                >
                  {t(key)}
                </button>
              ))}
            </div>
            <div className="account-fields">
              <label className="account-field account-field-span">
                <span className="account-field-label">{t("account.addressLine")}</span>
                <input
                  type="text"
                  value={addrLine1}
                  onChange={(e) => setAddrLine1(e.target.value)}
                  placeholder={t("account.addressLinePlaceholder")}
                  autoComplete="street-address"
                />
                {addrFieldErr.line ? (
                  <span className="err account-field-err">{addrFieldErr.line}</span>
                ) : null}
              </label>
              <label className="account-field account-field-span">
                <span className="account-field-label">{t("address.line2")}</span>
                <input
                  type="text"
                  value={addrLine2}
                  onChange={(e) => setAddrLine2(e.target.value)}
                  placeholder={t("address.line2Placeholder")}
                />
              </label>
              <label className="account-field">
                <span className="account-field-label">{t("account.addressPin")}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={addrPin}
                  onChange={(e) => setAddrPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="600119"
                  autoComplete="postal-code"
                />
                {addrFieldErr.pin ? (
                  <span className="err account-field-err">{addrFieldErr.pin}</span>
                ) : null}
              </label>
            </div>
            <div className="account-panel-actions">
              <button className="btn" type="button" disabled={addrBusy} onClick={() => void saveAddress()}>
                {addrBusy ? t("account.saving") : t("account.saveAddress")}
              </button>
              <button
                className="btn secondary"
                type="button"
                onClick={() => {
                  setShowAddAddr(false);
                  setAddrFieldErr({});
                }}
              >
                {t("address.cancel")}
              </button>
            </div>
          </div>
        ) : (
          <div className="account-panel-actions">
            <button
              className="btn"
              type="button"
              onClick={() => {
                setShowAddAddr(true);
                setAddrPin(pinCode || "600119");
              }}
            >
              {t("account.addAddress")}
            </button>
          </div>
        )}
      </section>

      <CreditPanel />

      <DeleteAccountPanel />

      <div className="account-footer">
        <Link className="btn account-browse-cta" href={browseHref}>
          {browseLabel}
        </Link>
      </div>
    </main>
  );
}

export default function AccountPage() {
  return (
    <RequireAuth role="CUSTOMER">
      <AccountInner />
    </RequireAuth>
  );
}
