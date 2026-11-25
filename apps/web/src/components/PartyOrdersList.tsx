"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { cateringBookingHref, cateringStatusKey, type CateringBooking } from "@/lib/catering";
import { formatInr } from "@/lib/money";

/** Customer's party bookings — renders nothing until they have one. */
export function PartyOrdersList() {
  const { t } = useLocale();
  const [bookings, setBookings] = useState<CateringBooking[]>([]);

  useEffect(() => {
    let cancelled = false;
    authFetch("/me/catering/bookings")
      .then(async (r) => {
        if (!r.ok || cancelled) return;
        const json = await r.json();
        setBookings((json.bookings as CateringBooking[]) ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!bookings.length) return null;
  return (
    <section className="card">
      <strong>{t("cat.myParties")}</strong>
      {bookings.map((b) => (
        <div key={b.publicId} className="row" style={{ marginTop: "0.6rem", gap: "0.5rem", flexWrap: "wrap" }}>
          <span>
            {b.plates}× {b.comboName} · {t("cat.when", { date: b.eventDate, time: b.eventTime })} ·{" "}
            {formatInr(b.totalPaise)}
          </span>
          <span className="chip">{t(cateringStatusKey(b.status))}</span>
          <Link className="btn sm secondary" href={cateringBookingHref(b.publicId)}>
            {t("cat.view")}
          </Link>
        </div>
      ))}
    </section>
  );
}
