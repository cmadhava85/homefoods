"use client";

import { useMemo, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";

/** Always same-origin proxy so mock /wa never hits staging (HMAC required there). */
const WA_API_BASE = "/lm-api";

type ChatMsg = {
  id: string;
  role: "user" | "bot" | "system";
  text: string;
  buttons?: string[];
};

type WaResponse = {
  ok?: boolean;
  intent?: string;
  replies?: Array<{ body: string; buttons?: string[] }>;
  publicId?: string;
  gatewayTxnId?: string | null;
  paymentUrl?: string;
  error?: string;
};

type Persona = "customer" | "cook";

const PERSONA_MOBILES: Record<Persona, string> = {
  customer: "+919840111111",
  cook: "+919876543211",
};

const PERSONA_QUICK: Record<Persona, string[]> = {
  customer: [
    "Menu",
    "Week csk-homemade-delights",
    "Orders",
    "Follow csk-homemade-delights",
    "Pay",
    "Cancel",
    "Family",
    "Order csk-homemade-delights 1 PICKUP",
  ],
  cook: [
    "Add Sambar rice 80",
    "My menu",
    "Skip",
    "Status",
    "Late requests",
    "Cancel requests",
  ],
};

const PERSONA_BLURB: Record<Persona, string> = {
  customer: "Menu · Week · Orders · Follow · Pay / Cancel · Family · PICKUP",
  cook: "Add dish · My menu · Cancel requests · Status → Cooking → Packed",
};

/** 1×1 PNG for mock menu photo attach in the simulator. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";


let seq = 0;
function mid() {
  seq += 1;
  return `m${Date.now()}-${seq}`;
}

export default function WhatsAppSimPage() {
  const { t, locale } = useLocale();
  const [persona, setPersona] = useState<Persona>("customer");
  const [from, setFrom] = useState(PERSONA_MOBILES.customer);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingPay, setPendingPay] = useState<{
    publicId: string;
    gatewayTxnId: string;
    paymentUrl?: string;
  } | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: mid(),
      role: "system",
      text: "WhatsApp-first simulator (same webhook as Meta). Switch Customer / Cook mobile below.",
    },
    {
      id: mid(),
      role: "bot",
      text: "Hi! Menu · Week <kitchen> all · Orders · Follow <kitchen> · Pay / Cancel.",
      buttons: ["Menu", "Orders", "Week csk-homemade-delights"],
    },
  ]);

  const quick = useMemo(() => PERSONA_QUICK[persona], [persona]);
  const personaLabel = persona === "customer" ? t("waSim.customer") : t("waSim.cook");

  function switchPersona(next: Persona) {
    setPersona(next);
    setFrom(PERSONA_MOBILES[next]);
    setPendingPay(null);
    const label = next === "customer" ? t("waSim.customer") : t("waSim.cook");
    setMessages((m) => [
      ...m,
      {
        id: mid(),
        role: "system",
        text: `${t("waSim.switched", { label })} · ${PERSONA_MOBILES[next]}\n${PERSONA_BLURB[next]}`,
      },
    ]);
  }

  async function sendText(raw: string) {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy(true);
    setText("");
    setMessages((m) => [...m, { id: mid(), role: "user", text: value }]);
    try {
      const res = await fetch(`${WA_API_BASE}/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, text: value, locale }),
      });
      const json = (await res.json()) as WaResponse;
      const replies = json.replies?.length
        ? json.replies
        : [
            {
              body: `${t("waSim.noReply")} — intent ${json.intent ?? "?"}${json.error ? `: ${json.error}` : ""}`,
            },
          ];
      setMessages((m) => [
        ...m,
        ...replies.map((r) => ({
          id: mid(),
          role: "bot" as const,
          text: r.body,
          buttons: r.buttons,
        })),
      ]);
      if (json.gatewayTxnId && json.publicId) {
        setPendingPay({
          publicId: json.publicId,
          gatewayTxnId: json.gatewayTxnId,
          paymentUrl: json.paymentUrl,
        });
      }
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: mid(), role: "system", text: `Error: ${(e as Error).message}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function sendMenuPhoto() {
    if (busy || persona !== "cook") return;
    setBusy(true);
    setMessages((m) => [...m, { id: mid(), role: "user", text: "📷 [menu photo]" }]);
    try {
      const res = await fetch(`${WA_API_BASE}/webhooks/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from,
          locale,
          imageBase64: TINY_PNG_B64,
          mimeType: "image/png",
        }),
      });
      const json = (await res.json()) as WaResponse;
      const replies = json.replies?.length
        ? json.replies
        : [
            {
              body: `${t("waSim.noReply")} — intent ${json.intent ?? "?"}${json.error ? `: ${json.error}` : ""}`,
            },
          ];
      setMessages((m) => [
        ...m,
        ...replies.map((r) => ({
          id: mid(),
          role: "bot" as const,
          text: r.body,
          buttons: r.buttons,
        })),
      ]);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: mid(), role: "system", text: `Error: ${(e as Error).message}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function confirmMockPay() {
    if (!pendingPay || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${WA_API_BASE}/payments/mock-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gatewayTxnId: pendingPay.gatewayTxnId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Pay failed");
      setMessages((m) => [
        ...m,
        {
          id: mid(),
          role: "bot",
          text: `Payment captured for ${pendingPay.publicId}. Status: ${json.order?.status ?? "PAID"}.\nYou and the cook both get WhatsApp updates for this order.`,
          buttons: ["Menu"],
        },
      ]);
      setPendingPay(null);
    } catch (e) {
      setMessages((m) => [
        ...m,
        { id: mid(), role: "system", text: `Pay error: ${(e as Error).message}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="content-stage">
      <h1>{t("waSim.title")}</h1>
      <p className="muted">{t("waSim.blurb")}</p>

      <div className="seg" style={{ marginBottom: "0.75rem" }}>
        {(["customer", "cook"] as Persona[]).map((p) => (
          <button
            key={p}
            type="button"
            className={persona === p ? "on" : ""}
            onClick={() => switchPersona(p)}
          >
            {p === "customer" ? t("waSim.customer") : t("waSim.cook")}
          </button>
        ))}
      </div>

      <div className="wa-shell">
      <div className="wa-frame">
        <div className="wa-top" style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "center" }}>
          <div>
            LocalMeals
            <small>{personaLabel}</small>
          </div>
          <input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            aria-label={t("waSim.yourMobile")}
            style={{
              maxWidth: 160,
              fontSize: "0.75rem",
              padding: "0.25rem 0.4rem",
              borderRadius: 8,
              border: 0,
            }}
          />
        </div>

        <div className="wa-thread">
          {messages.map((m) => (
            <div key={m.id} className={`wa-bubble ${m.role}`}>
              {m.text.replace(/\*([^*]+)\*/g, "$1")}
              {m.buttons?.length ? (
                <div className="wa-btns">
                  {m.buttons.map((b) => (
                    <button key={b} type="button" disabled={busy} onClick={() => void sendText(b)}>
                      {b}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        {pendingPay ? (
          <div
            style={{
              padding: "0.55rem 0.75rem",
              background: "#fff8e6",
              borderTop: "1px solid var(--line)",
              display: "flex",
              flexWrap: "wrap",
              gap: "0.45rem",
              alignItems: "center",
            }}
          >
            <span className="muted" style={{ flex: 1, fontSize: "0.8rem" }}>
              {t("waSim.unpaid", { id: pendingPay.publicId })}
              {pendingPay.paymentUrl ? (
                <>
                  {" "}
                  ·{" "}
                  <a href={pendingPay.paymentUrl} target="_blank" rel="noreferrer">
                    {t("waSim.openPay")}
                  </a>
                </>
              ) : null}
            </span>
            <button className="btn sm mustard" type="button" disabled={busy} onClick={confirmMockPay}>
              {t("waSim.confirmMock")}
            </button>
          </div>
        ) : null}

        <div className="wa-compose" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div className="wa-btns" style={{ marginTop: 0, marginBottom: "0.35rem" }}>
            {quick.map((cmd) => (
              <button key={cmd} type="button" disabled={busy} onClick={() => void sendText(cmd)}>
                {cmd}
              </button>
            ))}
          </div>
          <form
            style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}
            onSubmit={(e) => {
              e.preventDefault();
              void sendText(text);
            }}
          >
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                persona === "cook"
                  ? t("waSim.placeholderCook")
                  : t("waSim.placeholderCustomer")
              }
              disabled={busy}
              style={{ flex: 1, minWidth: 120 }}
            />
            <button className="btn sm" type="submit" disabled={busy || !text.trim()}>
              {t("waSim.send")}
            </button>
            {persona === "cook" ? (
              <button
                className="btn sm secondary"
                type="button"
                disabled={busy}
                onClick={() => void sendMenuPhoto()}
              >
                Attach photo
              </button>
            ) : null}
          </form>
        </div>
      </div>
      </div>
    </main>
  );
}
