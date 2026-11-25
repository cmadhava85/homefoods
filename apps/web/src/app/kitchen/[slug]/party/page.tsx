"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { cateringAmounts } from "@localmeals/domain";
import { localizedDishName } from "@localmeals/i18n";
import { useAuth } from "@/components/AuthProvider";
import { CheckoutAddressPicker, type SavedAddress } from "@/components/CheckoutAddressPicker";
import { FulfillmentChooser } from "@/components/FulfillmentChooser";
import { useLocale } from "@/components/LocaleProvider";
import { API_BASE } from "@/lib/api";
import { authFetch, loginPath } from "@/lib/auth";
import { cateringBookingHref, type CateringBooking, type CateringCombo } from "@/lib/catering";
import { flagOn, useFeatureFlags } from "@/lib/features";
import { needsCheckoutAddress, type FulfillmentMode } from "@/lib/fulfillment";
import { formatInr } from "@/lib/money";

type KitchenCatering = {
  kitchenSlug: string;
  kitchenName: string;
  cutoffHours: number;
  platformFeePaise: number;
  earliestEventDate: string;
  latestEventDate: string;
  fulfillment: { cookDelivery: boolean; pickup: boolean; customerArrange: boolean };
  combos: CateringCombo[];
};

export default function KitchenPartyPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const { t, locale } = useLocale();
  const { user } = useAuth();
  const flags = useFeatureFlags();
  const [data, setData] = useState<KitchenCatering | null>(null);
  const [off, setOff] = useState(false);
  const [comboId, setComboId] = useState<number | null>(null);
  const [plates, setPlates] = useState(0);
  const [eventDate, setEventDate] = useState("");
  const [eventTime, setEventTime] = useState("12:00");
  const [mode, setMode] = useState<FulfillmentMode>("DELIVERY");
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [addressId, setAddressId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  useEffect(() => {
    fetch(`${API_BASE}/kitchens/${slug}/catering`)
      .then(async (r) => {
        if (!r.ok) return setOff(true);
        const json = (await r.json()) as KitchenCatering;
        setData(json);
        setEventDate(json.earliestEventDate);
        if (!json.fulfillment.cookDelivery) {
          setMode(json.fulfillment.pickup ? "PICKUP" : "CUSTOMER_ARRANGE");
        }
        const first = json.combos[0];
        if (first) {
          setComboId(first.id);
          setPlates(first.minPlates);
        }
      })
      .catch(() => setOff(true));
  }, [slug]);

  useEffect(() => {
    if (!user || user.role !== "CUSTOMER") return;
    authFetch("/me/addresses")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) return;
        const list = (json.addresses as SavedAddress[]) ?? [];
        setAddresses(list);
        const def = list.find((a) => a.isDefault) ?? list[0];
        if (def) setAddressId(String(def.id));
      })
      .catch(() => undefined);
  }, [user]);

  const combo = data?.combos.find((c) => c.id === comboId) ?? null;
  const quote = useMemo(
    () =>
      combo && data
        ? cateringAmounts({
            pricePerPlatePaise: combo.pricePerPlatePaise,
            plates,
            platformFeePaise: data.platformFeePaise,
          })
        : null,
    [combo, data, plates],
  );

  if (off || !flagOn(flags, "catering_enabled")) {
    return (
      <main className="content-stage">
        <h1>{t("cat.title")}</h1>
        <p className="muted">{t("cat.off")}</p>
        <Link className="btn" href={`/kitchen/${slug}`}>
          ←
        </Link>
      </main>
    );
  }
  if (!data) return <p className="muted">…</p>;

  const needAddress = needsCheckoutAddress(mode);
  const platesOk = combo ? plates >= combo.minPlates && plates <= combo.maxPlates : false;

  async function book() {
    if (!combo) return;
    if (!user || user.role !== "CUSTOMER") {
      router.push(loginPath("CUSTOMER", `/kitchen/${slug}/party`));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch("/catering/bookings", {
        method: "POST",
        body: JSON.stringify({
          slug,
          comboId: combo.id,
          plates,
          eventDate,
          eventTime,
          fulfillmentMode: mode,
          ...(needAddress && addressId ? { addressId: Number(addressId) } : {}),
          note: note.trim() || null,
          idempotencyKey,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Booking failed");
      const booking = json.booking as CateringBooking;
      if (booking.paymentUrl) window.location.href = booking.paymentUrl;
      else router.push(cateringBookingHref(booking.publicId));
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="content-stage">
      <p>
        <Link href={`/kitchen/${slug}`}>← {data.kitchenName}</Link>
      </p>
      <h1>{t("cat.title")}</h1>
      <p className="muted">{t("cat.blurb", { hours: data.cutoffHours })}</p>

      {data.combos.length === 0 ? <p className="muted">{t("cat.noCombos")}</p> : null}
      {data.combos.map((c) => (
        <section key={c.id} className="card">
          <div className="row">
            <strong>{localizedDishName(locale, { itemName: c.name, itemNameTa: c.nameTa })}</strong>
            <span className="chip">{c.isVeg ? t("cat.veg") : t("cat.nonVeg")}</span>
          </div>
          {c.contents ? <p className="muted" style={{ margin: "0.35rem 0" }}>{c.contents}</p> : null}
          <div className="row">
            <span>
              {t("cat.perPlate", { price: formatInr(c.pricePerPlatePaise) })} ·{" "}
              {t("cat.minMax", { min: c.minPlates, max: c.maxPlates })}
            </span>
            <button
              type="button"
              className={`btn sm${comboId === c.id ? "" : " secondary"}`}
              onClick={() => {
                setComboId(c.id);
                setPlates((p) => Math.min(Math.max(p, c.minPlates), c.maxPlates));
              }}
            >
              {comboId === c.id ? t("cat.chosen") : t("cat.choose")}
            </button>
          </div>
        </section>
      ))}

      {combo && quote ? (
        <section className="card">
          <div className="field-row" style={{ flexWrap: "wrap", gap: "0.75rem" }}>
            <label>
              {t("cat.plates")}
              <input
                type="number"
                min={combo.minPlates}
                max={combo.maxPlates}
                value={plates || ""}
                onChange={(e) => setPlates(Number(e.target.value))}
              />
            </label>
            <label>
              {t("cat.eventDate")}
              <input
                type="date"
                min={data.earliestEventDate}
                max={data.latestEventDate}
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
              />
            </label>
            <label>
              {t("cat.eventTime")}
              <input
                type="time"
                min="06:00"
                max="22:59"
                value={eventTime}
                onChange={(e) => setEventTime(e.target.value)}
              />
            </label>
          </div>

          <FulfillmentChooser
            value={mode}
            onChange={setMode}
            offers={data.fulfillment}
            pickupAvailable={data.fulfillment.pickup}
            style={{ marginTop: "0.75rem" }}
          />
          {needAddress && user?.role === "CUSTOMER" ? (
            <CheckoutAddressPicker
              addresses={addresses}
              addressId={addressId}
              onChange={setAddressId}
              onCreated={(a) => {
                setAddresses((prev) => [...prev, a]);
                setAddressId(String(a.id));
              }}
              required
              compact
            />
          ) : null}

          <label style={{ display: "block", marginTop: "0.75rem" }}>
            {t("cat.note")}
            <textarea value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
          </label>

          <dl className="muted" style={{ marginTop: "0.75rem" }}>
            <div className="row">
              <dt>{t("cat.food", { plates, price: formatInr(combo.pricePerPlatePaise) })}</dt>
              <dd>{formatInr(quote.foodPaise)}</dd>
            </div>
            {quote.platformFeePaise > 0 ? (
              <div className="row">
                <dt>{t("cat.fee")}</dt>
                <dd>{formatInr(quote.platformFeePaise)}</dd>
              </div>
            ) : null}
            <div className="row">
              <dt>
                <strong>{t("cat.total")}</strong>
              </dt>
              <dd>
                <strong>{formatInr(quote.totalPaise)}</strong>
              </dd>
            </div>
            <div className="row">
              <dt>{t("cat.advance")}</dt>
              <dd>{formatInr(quote.advancePaise)}</dd>
            </div>
            <div className="row">
              <dt>{t("cat.balance")}</dt>
              <dd>{formatInr(quote.balancePaise)}</dd>
            </div>
          </dl>
          <p className="muted">{t("cat.policy", { hours: data.cutoffHours })}</p>
          {err ? <p className="err">{err}</p> : null}
          <button
            type="button"
            className="btn"
            disabled={busy || !platesOk || !eventDate || (needAddress && Boolean(user) && !addressId)}
            onClick={book}
          >
            {busy ? "…" : t("cat.book")}
          </button>
        </section>
      ) : null}
    </main>
  );
}
