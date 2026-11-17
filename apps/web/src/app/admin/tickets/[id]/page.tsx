"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RequireAuth } from "@/components/RequireAuth";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { type MsgKey } from "@localmeals/i18n";

type TicketDetail = {
  id: number;
  summary: string;
  status: string;
  category: string;
  photoUrl?: string | null;
  cookId?: string | null;
  orderId: number | null;
  order?: {
    id: number;
    publicId: string;
    status: string;
    settlementHold: boolean;
    itemName: string;
    qty: number;
  } | null;
  cook?: {
    id: string;
    kitchenName: string;
    slugHandle: string;
    mobileNumber: string;
    isActive: boolean;
    onboardingStatus: string;
  } | null;
};

const TRIAGE_CATEGORIES = [
  "QUALITY",
  "FOODBORNE",
  "WRONG_ITEM",
  "MISSING_DELIVERY",
  "DELAY",
  "PAYMENT",
  "COOK_OPS",
  "DOOR_NO_ANSWER",
  "OTHER",
] as const;

function TicketDetailInner() {
  const { id } = useParams<{ id: string }>();
  const { t } = useLocale();
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [category, setCategory] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setErr(null);
    authFetch(`/admin/tickets/${id}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Failed to load ticket");
        setTicket(json);
        setCategory(json.category);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : "Failed"));
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function refund(mode: "FULL" | "FOOD_ONLY") {
    if (!ticket?.orderId) return;
    setBusy(true);
    const res = await authFetch("/internal/ops/refunds", {
      method: "POST",
      body: JSON.stringify({
        orderId: ticket.orderId,
        ticketId: ticket.id,
        mode,
        reason: "Admin ticket resolution",
      }),
    });
    const json = await res.json();
    setMsg(JSON.stringify(json));
    setBusy(false);
    refresh();
  }

  async function hold() {
    if (!ticket?.orderId) return;
    setBusy(true);
    const res = await authFetch("/internal/ops/holds", {
      method: "POST",
      body: JSON.stringify({ orderId: ticket.orderId, reason: "Dispute pending" }),
    });
    const json = await res.json();
    setMsg(JSON.stringify(json));
    setBusy(false);
    refresh();
  }

  async function saveCategory() {
    if (!ticket) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(`/admin/tickets/${ticket.id}`, {
        method: "PATCH",
        body: JSON.stringify({ category }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Update failed");
      setMsg(t("admin.ticketUpdated"));
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resolveTicket() {
    if (!ticket) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(`/admin/tickets/${ticket.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "RESOLVED" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Resolve failed");
      setMsg(t("admin.ticketResolved"));
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pauseCook() {
    if (!ticket?.cook?.id) return;
    if (!confirm(t("admin.confirmPauseCook"))) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(`/internal/ops/cooks/${ticket.cook.id}/pause`, {
        method: "POST",
        body: JSON.stringify({ reason: `Ticket #${ticket.id}` }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Pause failed");
      setMsg(t("admin.cookPaused"));
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (err && !ticket) return <p className="err">{err}</p>;
  if (!ticket) return <p className="muted">{t("admin.loading")}</p>;

  const photoSrc = ticket.photoUrl ?? null;

  return (
    <main>
      <p className="muted">
        <Link href="/admin">{t("admin.back")}</Link>
      </p>
      <h1>{t("admin.ticket", { id: ticket.id })}</h1>
      <p>{ticket.summary}</p>
      <p className="muted">
        {ticket.category} · {ticket.status}
      </p>
      {err ? <p className="err">{err}</p> : null}

      {photoSrc ? (
        <div className="card" style={{ marginTop: "0.75rem" }}>
          <p className="muted" style={{ marginTop: 0 }}>
            {t("admin.concernPhoto")}
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoSrc}
            alt="Customer concern evidence"
            style={{ maxWidth: "100%", borderRadius: 12, display: "block" }}
          />
        </div>
      ) : null}

      <div className="card" style={{ marginTop: "0.75rem" }}>
        <h2 style={{ fontSize: "1.05rem", marginTop: 0 }}>{t("admin.triage")}</h2>
        <label className="order-field">
          {t("admin.reclassify")}
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            disabled={busy || ticket.status !== "OPEN"}
          >
            {TRIAGE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`orders.cat.${c}` as MsgKey)}
              </option>
            ))}
          </select>
        </label>
        <div className="actions" style={{ marginTop: "0.65rem" }}>
          <button
            className="btn secondary"
            type="button"
            disabled={busy || ticket.status !== "OPEN" || category === ticket.category}
            onClick={() => void saveCategory()}
          >
            {t("admin.saveCategory")}
          </button>
          {ticket.status === "OPEN" ? (
            <button className="btn" type="button" disabled={busy} onClick={() => void resolveTicket()}>
              {t("admin.markResolved")}
            </button>
          ) : null}
          {ticket.cook?.isActive ? (
            <button className="btn mustard" type="button" disabled={busy} onClick={() => void pauseCook()}>
              {t("admin.pauseCookFromTicket")}
            </button>
          ) : null}
        </div>
        {ticket.cook ? (
          <p className="muted" style={{ marginBottom: 0 }}>
            {ticket.cook.kitchenName} · /{ticket.cook.slugHandle}
            {!ticket.cook.isActive ? ` · ${t("admin.paused")}` : ""}
          </p>
        ) : null}
      </div>

      {ticket.order ? (
        <div className="card">
          <div className="row">
            <strong>
              {ticket.order.publicId} · {ticket.order.qty}× {ticket.order.itemName}
            </strong>
            <span className="chip">{ticket.order.status}</span>
          </div>
          {ticket.order.settlementHold ? (
            <p className="muted">{t("admin.settlementHold")}</p>
          ) : null}
          {ticket.status === "OPEN" ? (
            <div className="actions">
              <button className="btn" type="button" disabled={busy} onClick={() => refund("FULL")}>
                {t("admin.fullRefund")}
              </button>
              <button
                className="btn secondary"
                type="button"
                disabled={busy}
                onClick={() => refund("FOOD_ONLY")}
              >
                {t("admin.foodOnly")}
              </button>
              <button className="btn mustard" type="button" disabled={busy} onClick={hold}>
                {t("admin.holdSettlement")}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="muted">{t("admin.noLinkedOrder")}</p>
      )}

      {msg ? <pre className="ok">{msg}</pre> : null}
    </main>
  );
}

export default function TicketDetailPage() {
  return (
    <RequireAuth role="ADMIN">
      <TicketDetailInner />
    </RequireAuth>
  );
}
