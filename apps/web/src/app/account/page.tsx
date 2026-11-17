"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { useAuth } from "@/components/AuthProvider";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch, setSession, type AuthUser } from "@/lib/auth";
import {
  validateAddressLine,
  validateFullName,
  validatePin,
} from "@localmeals/i18n";

type Profile = {
  mobile: string;
  fullName: string;
  pinCode: string;
  needsName: boolean;
  addresses: Array<{
    id: number;
    label: string;
    line1: string;
    pinCode: string;
    isDefault: boolean;
  }>;
};

type AddrLabel = "HOME" | "OFFICE" | "OTHER";

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
        setPinCode(json.pinCode ?? "600119");
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
      const res = await authFetch("/me/addresses", {
        method: "POST",
        body: JSON.stringify({
          label: addrLabel,
          line1: addrLine1.trim(),
          pinCode: addrPin.trim(),
          isDefault: !(profile?.addresses?.length),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save address");
      setMsg(t("account.addressSaved"));
      setShowAddAddr(false);
      setAddrLine1("");
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

  return (
    <main>
      <h1>{t("account.title")}</h1>
      <p className="muted">{t("account.blurb")}</p>

      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="ok">{msg}</p> : null}

      {profile?.needsName ? (
        <p className="ok status-banner warn">{t("account.needsName")}</p>
      ) : null}

      <section className="card">
        <strong>{t("account.profile")}</strong>
        <p className="muted" style={{ marginTop: "0.35rem" }}>
          {profile?.mobile ?? user?.mobile}
        </p>
        <label className="order-field" style={{ display: "block", marginTop: "0.75rem" }}>
          <span>{t("account.fullName")}</span>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={t("account.fullName")}
            style={{ width: "100%", marginTop: "0.35rem" }}
            aria-invalid={Boolean(fieldErr.name)}
          />
          {fieldErr.name ? <p className="err" style={{ marginTop: 4 }}>{fieldErr.name}</p> : null}
        </label>
        <label className="order-field" style={{ display: "block", marginTop: "0.75rem" }}>
          <span>{t("account.pin")}</span>
          <input
            type="text"
            inputMode="numeric"
            value={pinCode}
            onChange={(e) => setPinCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="600119"
            style={{ width: "100%", marginTop: "0.35rem" }}
            aria-invalid={Boolean(fieldErr.pin)}
          />
          {fieldErr.pin ? <p className="err" style={{ marginTop: 4 }}>{fieldErr.pin}</p> : null}
        </label>
        <button
          className="btn"
          type="button"
          style={{ marginTop: "0.85rem" }}
          disabled={busy || fullName.trim().length < 2 || pinCode.length !== 6}
          onClick={save}
        >
          {busy ? t("account.saving") : t("account.saveProfile")}
        </button>
      </section>

      <section className="card" style={{ marginTop: "1rem" }}>
        <strong>{t("account.addresses")}</strong>
        {!profile?.addresses?.length ? (
          <p className="muted">{t("account.noAddresses")}</p>
        ) : (
          <ul className="meta-list" style={{ marginTop: "0.5rem" }}>
            {profile.addresses.map((a) => (
              <li key={a.id} style={{ marginBottom: "0.45rem" }}>
                <strong>{a.label}</strong>
                {a.isDefault ? " · default" : ""} — {a.line1} · {a.pinCode}
                {!a.isDefault ? (
                  <button
                    className="btn sm secondary"
                    type="button"
                    style={{ marginLeft: "0.5rem" }}
                    disabled={addrBusy}
                    onClick={() => setDefaultAddress(a.id)}
                  >
                    {t("account.setDefault")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {showAddAddr ? (
          <div style={{ marginTop: "0.75rem" }}>
            <label className="order-field" style={{ display: "block" }}>
              <span>Label</span>
              <select
                value={addrLabel}
                onChange={(e) => setAddrLabel(e.target.value as AddrLabel)}
                style={{ display: "block", marginTop: "0.25rem" }}
              >
                <option value="HOME">HOME</option>
                <option value="OFFICE">OFFICE</option>
                <option value="OTHER">OTHER</option>
              </select>
            </label>
            <label className="order-field" style={{ display: "block", marginTop: "0.5rem" }}>
              <span>Line</span>
              <input
                type="text"
                value={addrLine1}
                onChange={(e) => setAddrLine1(e.target.value)}
                style={{ width: "100%", marginTop: "0.25rem" }}
              />
              {addrFieldErr.line ? <p className="err">{addrFieldErr.line}</p> : null}
            </label>
            <label className="order-field" style={{ display: "block", marginTop: "0.5rem" }}>
              <span>PIN</span>
              <input
                type="text"
                inputMode="numeric"
                value={addrPin}
                onChange={(e) => setAddrPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                style={{ width: "100%", marginTop: "0.25rem" }}
              />
              {addrFieldErr.pin ? <p className="err">{addrFieldErr.pin}</p> : null}
            </label>
            <div className="actions" style={{ marginTop: "0.65rem" }}>
              <button className="btn sm" type="button" disabled={addrBusy} onClick={saveAddress}>
                {addrBusy ? t("account.saving") : t("account.addAddress")}
              </button>
              <button
                className="btn sm secondary"
                type="button"
                onClick={() => setShowAddAddr(false)}
              >
                {t("common.clear")}
              </button>
            </div>
          </div>
        ) : (
          <div className="actions" style={{ marginTop: "0.75rem" }}>
            <button className="btn sm" type="button" onClick={() => setShowAddAddr(true)}>
              {t("account.addAddress")}
            </button>
            <Link className="btn sm secondary" href="/discover">
              {t("account.findKitchens")}
            </Link>
          </div>
        )}
      </section>
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
