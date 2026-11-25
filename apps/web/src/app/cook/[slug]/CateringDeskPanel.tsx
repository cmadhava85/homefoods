"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { cateringStatusKey, type CateringBooking, type CateringCombo } from "@/lib/catering";
import { formatInr } from "@/lib/money";

type Desk = {
  platformEnabled: boolean;
  kitchenLive: boolean;
  settings: { enabled: boolean; cutoffHours: number; dailyPlateCap: number };
  limits: { minMoq: number; maxPlates: number; cutoffHoursMin: number; cutoffHoursMax: number };
  combos: CateringCombo[];
  bookings: CateringBooking[];
};

type ComboForm = { id?: number; name: string; contents: string; priceRupees: string; minPlates: string; maxPlates: string; isVeg: boolean };
const EMPTY_FORM: ComboForm = { name: "", contents: "", priceRupees: "", minPlates: "20", maxPlates: "100", isVeg: true };

/** Cook desk → Party orders: opt-in, cut-off, daily cap, combos, upcoming bookings. */
export function CateringDeskPanel({ slug }: { slug: string }) {
  const { t } = useLocale();
  const [desk, setDesk] = useState<Desk | null>(null);
  const [settings, setSettings] = useState<Desk["settings"] | null>(null);
  const [form, setForm] = useState<ComboForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await authFetch(`/cooks/${slug}/catering`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? t("cat.loadFailed"));
    setDesk(json as Desk);
    setSettings((json as Desk).settings);
  }, [slug, t]);

  useEffect(() => {
    load().catch((e) => setErr((e as Error).message));
  }, [load]);

  async function run(path: string, init: RequestInit, ok?: string) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await authFetch(path, init);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed");
      if (ok) setMsg(ok);
      await load();
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const saveSettings = () =>
    settings && run(`/cooks/${slug}/catering/settings`, { method: "PATCH", body: JSON.stringify(settings) }, t("cat.desk.saved"));

  async function saveCombo() {
    const body = {
      name: form.name.trim(),
      contents: form.contents.trim() || null,
      pricePerPlatePaise: Math.round(Number(form.priceRupees) * 100),
      minPlates: Number(form.minPlates),
      maxPlates: Number(form.maxPlates),
      isVeg: form.isVeg,
    };
    const done = await run(
      form.id ? `/cooks/${slug}/catering/combos/${form.id}` : `/cooks/${slug}/catering/combos`,
      { method: form.id ? "PUT" : "POST", body: JSON.stringify(body) },
      t("cat.desk.saved"),
    );
    if (done) setForm(EMPTY_FORM);
  }

  const toggleCombo = (c: CateringCombo) =>
    run(`/cooks/${slug}/catering/combos/${c.id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: c.name,
        nameTa: c.nameTa,
        contents: c.contents,
        pricePerPlatePaise: c.pricePerPlatePaise,
        minPlates: c.minPlates,
        maxPlates: c.maxPlates,
        isVeg: c.isVeg,
        imageUrl: c.imageUrl,
        isActive: !c.isActive,
      }),
    });

  async function cancelBooking(b: CateringBooking) {
    if (!confirm(t("cat.desk.cancelConfirm"))) return;
    const reason = prompt(t("cat.admin.reasonPrompt")) ?? "";
    await run(`/cooks/${slug}/catering/bookings/${b.publicId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: reason.trim() || null }),
    });
  }

  if (!desk || !settings) {
    return err ? <p className="err">{err}</p> : <p className="muted">…</p>;
  }

  return (
    <section aria-label={t("cat.desk.title")}>
      <h2>{t("cat.desk.title")}</h2>
      <p className="muted">{t("cat.desk.blurb")}</p>
      {!desk.kitchenLive ? <p className="err">{t("cat.desk.notLive")}</p> : null}
      {err ? <p className="err">{err}</p> : null}
      {msg ? <p className="ok">{msg}</p> : null}

      <div className="card">
        <label className="row">
          <span>{t("cat.desk.enable")}</span>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={!desk.kitchenLive}
            onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
          />
        </label>
        <div className="field-row" style={{ flexWrap: "wrap", gap: "0.75rem", marginTop: "0.5rem" }}>
          <label>
            {t("cat.desk.cutoff")}
            <input
              type="number"
              min={desk.limits.cutoffHoursMin}
              max={desk.limits.cutoffHoursMax}
              value={settings.cutoffHours}
              onChange={(e) => setSettings({ ...settings, cutoffHours: Number(e.target.value) })}
            />
          </label>
          <label>
            {t("cat.desk.cap")}
            <input
              type="number"
              min={desk.limits.minMoq}
              value={settings.dailyPlateCap}
              onChange={(e) => setSettings({ ...settings, dailyPlateCap: Number(e.target.value) })}
            />
          </label>
        </div>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void saveSettings()}>
          {t("cat.desk.save")}
        </button>
      </div>

      <h3>{t("cat.desk.combos")}</h3>
      {desk.combos.map((c) => (
        <div key={c.id} className="card">
          <div className="row">
            <strong>{c.name}</strong>
            {!c.isActive ? <span className="chip">{t("cat.desk.hidden")}</span> : null}
          </div>
          {c.contents ? <p className="muted" style={{ margin: "0.35rem 0" }}>{c.contents}</p> : null}
          <p className="muted">
            {t("cat.perPlate", { price: formatInr(c.pricePerPlatePaise) })} · {t("cat.minMax", { min: c.minPlates, max: c.maxPlates })}
          </p>
          <div className="row" style={{ justifyContent: "flex-start", gap: "0.5rem" }}>
            <button
              type="button"
              className="btn sm secondary"
              disabled={busy}
              onClick={() =>
                setForm({
                  id: c.id,
                  name: c.name,
                  contents: c.contents ?? "",
                  priceRupees: String(c.pricePerPlatePaise / 100),
                  minPlates: String(c.minPlates),
                  maxPlates: String(c.maxPlates),
                  isVeg: c.isVeg,
                })
              }
            >
              ✎
            </button>
            <button type="button" className="btn sm secondary" disabled={busy} onClick={() => void toggleCombo(c)}>
              {c.isActive ? t("cat.desk.hide") : t("cat.desk.show")}
            </button>
          </div>
        </div>
      ))}

      <div className="card">
        <strong>{form.id ? `✎ ${form.name}` : t("cat.desk.newCombo")}</strong>
        <div className="field-row" style={{ flexWrap: "wrap", gap: "0.75rem", marginTop: "0.5rem" }}>
          <label>
            {t("cat.desk.name")}
            <input value={form.name} maxLength={100} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            {t("cat.desk.price")}
            <input
              type="number"
              min={1}
              value={form.priceRupees}
              onChange={(e) => setForm({ ...form, priceRupees: e.target.value })}
            />
          </label>
          <label>
            {t("cat.desk.min")}
            <input
              type="number"
              min={desk.limits.minMoq}
              max={desk.limits.maxPlates}
              value={form.minPlates}
              onChange={(e) => setForm({ ...form, minPlates: e.target.value })}
            />
          </label>
          <label>
            {t("cat.desk.max")}
            <input
              type="number"
              min={desk.limits.minMoq}
              max={desk.limits.maxPlates}
              value={form.maxPlates}
              onChange={(e) => setForm({ ...form, maxPlates: e.target.value })}
            />
          </label>
          <label className="row">
            <span>{t("cat.veg")}</span>
            <input type="checkbox" checked={form.isVeg} onChange={(e) => setForm({ ...form, isVeg: e.target.checked })} />
          </label>
        </div>
        <label style={{ display: "block", marginTop: "0.5rem" }}>
          {t("cat.desk.contents")}
          <textarea
            rows={2}
            maxLength={500}
            value={form.contents}
            onChange={(e) => setForm({ ...form, contents: e.target.value })}
          />
        </label>
        <div className="row" style={{ justifyContent: "flex-start", gap: "0.5rem" }}>
          <button
            type="button"
            className="btn sm"
            disabled={busy || form.name.trim().length < 2 || !(Number(form.priceRupees) > 0)}
            onClick={() => void saveCombo()}
          >
            {t("cat.desk.save")}
          </button>
          {form.id ? (
            <button type="button" className="btn sm secondary" onClick={() => setForm(EMPTY_FORM)}>
              ✕
            </button>
          ) : null}
        </div>
      </div>

      <h3>{t("cat.desk.bookings")}</h3>
      {desk.bookings.length === 0 ? <p className="muted">{t("cat.desk.none")}</p> : null}
      {desk.bookings.map((b) => (
        <div key={b.publicId} className="card">
          <div className="row">
            <strong>
              {b.publicId} · {b.plates}× {b.comboName}
            </strong>
            <span className="chip">{t(cateringStatusKey(b.status))}</span>
          </div>
          <p>{t("cat.when", { date: b.eventDate, time: b.eventTime })}</p>
          {b.customerMobile ? (
            <p className="muted">
              {b.customerMobile} · {b.deliveryAddress}
            </p>
          ) : (
            <p className="muted">{t("cat.desk.contactAfterPay")}</p>
          )}
          {b.note ? <p className="muted">“{b.note}”</p> : null}
          <p className="muted">
            {t("cat.total")} {formatInr(b.foodPaise)} · {t("cat.paid")} {formatInr(b.paidPaise)}
          </p>
          <div className="row" style={{ justifyContent: "flex-start", gap: "0.5rem" }}>
            {b.status === "PAID" ? (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => void run(`/cooks/${slug}/catering/bookings/${b.publicId}/complete`, { method: "POST", body: "{}" })}
              >
                {t("cat.desk.complete")}
              </button>
            ) : null}
            {b.status === "AWAITING_ADVANCE" || b.status === "ADVANCE_PAID" || b.status === "PAID" ? (
              <button type="button" className="btn sm secondary" disabled={busy} onClick={() => void cancelBooking(b)}>
                {t("cat.desk.cancel")}
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}
