"use client";

import Link from "next/link";
import { useLocale } from "@/components/LocaleProvider";
import { hideCookOnboard, kitchensBrowseHref } from "@/lib/soloKitchen";

const HERO_IMG =
  "https://images.unsplash.com/photo-1546833999-b9f581a1996d?auto=format&fit=crop&w=2000&q=80";

export default function HomePage() {
  const { t } = useLocale();
  const browse = kitchensBrowseHref();
  const showCookCta = !hideCookOnboard();

  return (
    <main className="home">
      <section className="bleed hero" aria-label="LocalMeals">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="hero-media"
          src={HERO_IMG}
          alt="Home-cooked lunch of chapati, sabzi and dal on a steel thali"
        />
        <div className="hero-shade" />
        <div className="hero-grain" aria-hidden />
        <div className="hero-copy">
          <p className="hero-kicker">{t("home.kicker")}</p>
          <h1 className="hero-brand">LocalMeals</h1>
          <p className="hero-line">{t("home.tagline")}</p>
          <p className="hero-sub">{t("home.sub")}</p>
          <div className="hero-actions">
            <Link className="btn mustard" href={`/login?role=customer&next=${encodeURIComponent(browse)}`}>
              {t("home.orderLunch")}
            </Link>
            <Link className="btn ghost" href={browse}>
              {t("home.browse")}
            </Link>
          </div>
        </div>
      </section>

      <section className="home-promise" aria-label="How LocalMeals works">
        <h2 className="home-promise-title">{t("home.promiseTitle")}</h2>
        <p className="muted home-promise-lead">{t("home.promiseLead")}</p>
        <ol className="home-steps">
          <li>
            <span className="home-step-num">1</span>
            <div>
              <strong>{t("home.step1Title")}</strong>
              <p className="muted">{t("home.step1Body")}</p>
            </div>
          </li>
          <li>
            <span className="home-step-num">2</span>
            <div>
              <strong>{t("home.step2Title")}</strong>
              <p className="muted">{t("home.step2Body")}</p>
            </div>
          </li>
          <li>
            <span className="home-step-num">3</span>
            <div>
              <strong>{t("home.step3Title")}</strong>
              <p className="muted">{t("home.step3Body")}</p>
            </div>
          </li>
        </ol>
      </section>

      {showCookCta ? (
        <section className="home-cook-cta" aria-label="Cook enrollment">
          <h2 className="home-promise-title">{t("home.cookCtaTitle")}</h2>
          <p className="muted home-promise-lead">{t("home.cookCtaBody")}</p>
          <Link className="btn" href="/cook/onboard">
            {t("home.cookCta")}
          </Link>
        </section>
      ) : null}
    </main>
  );
}
