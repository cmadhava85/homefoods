"use client";

import { uploadSrc } from "@/lib/uploadUrl";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useLocale } from "@/components/LocaleProvider";
import { API_BASE } from "@/lib/api";
import { authFetch } from "@/lib/auth";

type Cook = {
  id: string;
  kitchenName: string;
  slugHandle: string;
  pinCode: string;
  fssaiNumber: string | null;
  lunchCutoff?: string;
  orderingOpen?: boolean;
  nextServiceDate?: string | null;
  openStatusLabel?: string;
  coverImageUrl?: string | null;
  platesThisWeek?: number;
  reviews?: { average: number | null; count: number; public: boolean };
  sponsored?: boolean;
};

type ExternalAd = {
  id: number;
  title: string;
  body: string | null;
  ctaUrl: string | null;
  imageUrl: string | null;
};

type MyKitchen = {
  id: string;
  kitchenName: string;
  slugHandle: string;
  followed?: boolean;
  recent?: boolean;
  orderingOpen?: boolean;
  nextServiceDate?: string | null;
  openStatusLabel?: string;
};

const FALLBACK_IMGS = [
  "https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1585937421612-70a008356fbe?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1547592166-23ac45744acd?auto=format&fit=crop&w=900&q=80",
  "https://images.unsplash.com/photo-1565557623262-b51c2513a41f?auto=format&fit=crop&w=900&q=80",
];

const PIN_KEY = "lm_pin";

function imgSrc(url: string | null | undefined, i: number) {
  return uploadSrc(url) ?? FALLBACK_IMGS[i % FALLBACK_IMGS.length];
}

export function DiscoverClient() {
  const { user } = useAuth();
  const { t } = useLocale();

  function openLabel(
    k: Pick<Cook, "orderingOpen" | "openStatusLabel" | "nextServiceDate" | "lunchCutoff">,
  ) {
    if (k.openStatusLabel) return k.openStatusLabel;
    if (k.orderingOpen) return t("discover.openBy", { cutoff: k.lunchCutoff ?? "08:00" });
    if (k.nextServiceDate) return t("discover.closedNext", { date: k.nextServiceDate });
    return t("discover.closedNow");
  }
  const [pin, setPin] = useState("600119");
  const [pinDraft, setPinDraft] = useState("600119");
  const [kitchens, setKitchens] = useState<Cook[]>([]);
  const [externalAds, setExternalAds] = useState<ExternalAd[]>([]);
  const [mine, setMine] = useState<MyKitchen[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(PIN_KEY);
      if (saved && /^\d{6}$/.test(saved)) {
        setPin(saved);
        setPinDraft(saved);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback((p: string) => {
    setLoading(true);
    setErr(null);
    Promise.all([
      fetch(`${API_BASE}/kitchens?pin=${encodeURIComponent(p)}`).then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? "Could not load kitchens");
        return Array.isArray(json) ? (json as Cook[]) : [];
      }),
      fetch(`${API_BASE}/ads?pin=${encodeURIComponent(p)}`)
        .then(async (r) => {
          const json = await r.json();
          if (!r.ok) return [] as ExternalAd[];
          return json.adsEnabled && Array.isArray(json.external)
            ? (json.external as ExternalAd[])
            : [];
        })
        .catch(() => [] as ExternalAd[]),
    ])
      .then(([ks, ads]) => {
        setKitchens(ks);
        setExternalAds(ads);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(pin);
  }, [pin, load]);

  useEffect(() => {
    if (!user || user.role !== "CUSTOMER") {
      setMine([]);
      return;
    }
    let cancelled = false;
    authFetch("/me/profile")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || cancelled) return;
        const p = String(json.pinCode ?? "");
        if (/^\d{6}$/.test(p)) {
          try {
            localStorage.setItem(PIN_KEY, p);
          } catch {
            /* ignore */
          }
          setPin(p);
          setPinDraft(p);
        }
      })
      .catch(() => undefined);
    authFetch("/me/kitchens")
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || cancelled) return;
        setMine((json.kitchens as MyKitchen[]) ?? []);
      })
      .catch(() => {
        if (!cancelled) setMine([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  async function applyPin() {
    const next = pinDraft.trim();
    if (!/^\d{6}$/.test(next)) {
      setErr(t("account.pinInvalid"));
      return;
    }
    try {
      localStorage.setItem(PIN_KEY, next);
    } catch {
      /* ignore */
    }
    setPin(next);
    if (user?.role === "CUSTOMER") {
      try {
        const res = await authFetch("/me/profile", {
          method: "PATCH",
          body: JSON.stringify({ pinCode: next }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Could not save pin");
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not save pin to account");
      }
    }
  }

  return (
    <main className="discover-page">
      <header className="discover-hero">
        <div className="discover-hero-copy">
          <p className="discover-kicker">Pin {pin}</p>
          <h1>{t("discover.title")}</h1>
          <p className="discover-lead">{t("discover.lead")}</p>
          <div className="discover-pin">
            <label>
              <span className="muted">{t("discover.yourPin")}</span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={pinDraft}
                onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, "").slice(0, 6))}
                aria-label={t("discover.yourPin")}
              />
            </label>
            <button className="btn sm" type="button" onClick={applyPin}>
              {t("common.update")}
            </button>
          </div>
        </div>
      </header>

      {mine.length > 0 ? (
        <section className="discover-yours" aria-label={t("discover.yours")}>
          <div className="discover-section-head">
            <h2>{t("discover.yours")}</h2>
            <p className="muted">{t("discover.yoursMeta")}</p>
          </div>
          <div className="discover-yours-strip">
            {mine.map((k) => (
              <Link
                key={k.id}
                href={`/kitchen/${k.slugHandle}`}
                className={`discover-yours-chip${k.orderingOpen ? " open" : ""}`}
              >
                <span className="discover-yours-name">{k.kitchenName}</span>
                <span className="discover-yours-meta">
                  {k.followed ? t("common.following") : t("common.recent")}
                  {" · "}
                  {k.orderingOpen
                    ? t("common.open")
                    : k.nextServiceDate
                      ? t("discover.next", { date: k.nextServiceDate.slice(5) })
                      : t("common.closed")}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {loading ? <p className="muted discover-status">{t("discover.loading")}</p> : null}
      {err ? <p className="err">{err}</p> : null}

      {!loading && externalAds.length > 0 ? (
        <section className="discover-ads" aria-label={t("discover.sponsored")}>
          {externalAds.map((ad) => {
            const inner = (
              <>
                <strong>{ad.title}</strong>
                {ad.body ? <p className="muted">{ad.body}</p> : null}
                <span className="discover-ad-badge">{t("discover.sponsored")}</span>
              </>
            );
            return ad.ctaUrl ? (
              <a
                key={ad.id}
                className="discover-ad-card"
                href={ad.ctaUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {inner}
              </a>
            ) : (
              <div key={ad.id} className="discover-ad-card">
                {inner}
              </div>
            );
          })}
        </section>
      ) : null}

      {!loading && !err && kitchens.length === 0 ? (
        <div className="card empty-card">
          <h2>{t("discover.emptyTitle", { pin })}</h2>
          <p className="muted">{t("discover.emptyHint")}</p>
        </div>
      ) : null}

      <div className="discover-grid">
        {kitchens.map((k, i) => (
          <Link
            key={k.id}
            href={`/kitchen/${k.slugHandle}`}
            className={`kitchen-tile${k.sponsored ? " sponsored" : ""}`}
            style={{ animationDelay: `${i * 70}ms` }}
          >
            <div className="kitchen-tile-media-wrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="kitchen-tile-media"
                src={imgSrc(k.coverImageUrl, i)}
                alt=""
              />
              <div className="kitchen-tile-shade" />
              <span className={`kitchen-tile-status${k.orderingOpen ? " open" : ""}`}>
                {k.orderingOpen ? t("common.openNow") : t("common.closed")}
              </span>
              {k.sponsored ? (
                <span className="kitchen-tile-sponsored">{t("discover.sponsored")}</span>
              ) : null}
              <h2 className="kitchen-tile-title">{k.kitchenName}</h2>
            </div>
            <div className="kitchen-tile-body">
              <ul className="meta-list tile-meta">
                <li>FSSAI {k.fssaiNumber}</li>
                <li>{openLabel(k)}</li>
                {typeof k.platesThisWeek === "number" && k.platesThisWeek > 0 ? (
                  <li>{t("discover.platesWeek", { n: k.platesThisWeek })}</li>
                ) : (
                  <li>{t("discover.building")}</li>
                )}
                {k.reviews?.public && k.reviews.average != null ? (
                  <li>
                    {t("discover.reviews", {
                      avg: k.reviews.average.toFixed(1),
                      count: k.reviews.count,
                    })}
                  </li>
                ) : (
                  <li>{t("common.newKitchen")}</li>
                )}
              </ul>
              <span className="tile-cta-link">{t("discover.seeMenu")} →</span>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
