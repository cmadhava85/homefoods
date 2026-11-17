"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { flagOn, useFeatureFlags } from "@/lib/features";

type FamilyLink = {
  id: number;
  seniorMobile: string;
  payerMobile: string;
  status: string;
  role: "SENIOR" | "PAYER";
  createdAt: string;
  activatedAt: string | null;
};

function FamilyInner() {
  const { t } = useLocale();
  const flags = useFeatureFlags();
  const [links, setLinks] = useState<FamilyLink[]>([]);
  const [payerMobile, setPayerMobile] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    authFetch("/family/links")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load");
        setLinks(json.links ?? []);
      })
      .catch((e) => setErr((e as Error).message));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function invite() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch("/family/links", {
        method: "POST",
        body: JSON.stringify({ payerMobile }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Invite failed");
      setMsg(`Invite sent to ${json.payerMobile} — they must accept under Family.`);
      setPayerMobile("");
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function accept(id: number) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/family/links/${id}/accept`, {
        method: "POST",
        body: "{}",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Accept failed");
      setMsg("Family link active — they can ask you to pay for meals.");
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    if (!confirm("Revoke this family link?")) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(`/family/links/${id}/revoke`, {
        method: "POST",
        body: "{}",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Revoke failed");
      setMsg("Link revoked");
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const pendingForMe = links.filter((l) => l.role === "PAYER" && l.status === "PENDING");
  const asSenior = links.filter((l) => l.role === "SENIOR");
  const asPayer = links.filter((l) => l.role === "PAYER" && l.status !== "PENDING");

  if (!flagOn(flags, "child_pays_enabled")) {
    return (
      <main>
        <h1>{t("family.title")}</h1>
        <p className="muted">{t("orders.featureOff")}</p>
        <Link className="btn" href="/orders">
          {t("orders.title")}
        </Link>
      </main>
    );
  }

  return (
    <main>
      <h1>{t("family.title")}</h1>
      <p className="muted">{t("family.blurb")}</p>

      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="ok">{msg}</p> : null}

      {pendingForMe.length > 0 ? (
        <section className="card">
          <strong>{t("family.invites")}</strong>
          {pendingForMe.map((l) => (
            <div key={l.id} className="row" style={{ marginTop: "0.65rem" }}>
              <span>
                {t("family.payFor")} <strong>{l.seniorMobile}</strong>
              </span>
              <button className="btn sm" type="button" disabled={busy} onClick={() => accept(l.id)}>
                {t("common.accept")}
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {asPayer.some((l) => l.status === "ACTIVE") ? (
        <section className="card">
          <strong>{t("family.howTitle")}</strong>
          <ol className="muted" style={{ margin: "0.5rem 0 0.75rem", paddingLeft: "1.2rem" }}>
            <li>{t("family.how1")}</li>
            <li>{t("family.how2")}</li>
            <li>{t("family.how3")}</li>
          </ol>
          <Link className="btn sm" href="/orders">
            {t("family.openOrders")}
          </Link>
        </section>
      ) : null}

      <section className="card">
        <strong>Invite a payer</strong>
        <p className="muted">
          {t("family.invitePayer")}
        </p>
        <div className="field-row" style={{ flexWrap: "wrap" }}>
          <input
            type="tel"
            value={payerMobile}
            onChange={(e) => setPayerMobile(e.target.value)}
            placeholder="+9198…"
            style={{ flex: "1 1 160px", minWidth: 140 }}
          />
          <button
            className="btn sm"
            type="button"
            disabled={busy || payerMobile.trim().length < 10}
            onClick={invite}
          >
            {busy ? "…" : t("family.sendInvite")}
          </button>
        </div>
      </section>

      <h2 style={{ marginTop: "1.25rem" }}>{t("family.yourPayers")}</h2>
      {asSenior.length === 0 && asPayer.length === 0 ? (
        <p className="muted">{t("family.none")}</p>
      ) : null}
      {[...asSenior, ...asPayer].map((l) => (
        <div key={`${l.role}-${l.id}`} className="card">
          <div className="row">
            <strong>
              {l.role === "SENIOR" ? t("family.yourPayers") : t("family.youPayFor")}
            </strong>
            <span className="chip">{l.status}</span>
          </div>
          <p className="muted" style={{ margin: "0.35rem 0" }}>
            {l.role === "SENIOR"
              ? `${t("family.payFor")} ${l.payerMobile}`
              : `${t("family.payFor")} ${l.seniorMobile}`}
          </p>
          {l.status !== "REVOKED" ? (
            <button
              className="btn sm secondary"
              type="button"
              disabled={busy}
              onClick={() => revoke(l.id)}
            >
              {t("family.revoke")}
            </button>
          ) : null}
        </div>
      ))}
    </main>
  );
}

export default function FamilyPage() {
  return (
    <RequireAuth role="CUSTOMER">
      <FamilyInner />
    </RequireAuth>
  );
}
