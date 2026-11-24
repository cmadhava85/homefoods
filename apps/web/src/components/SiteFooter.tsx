"use client";

import Link from "next/link";
import { useLocale } from "@/components/LocaleProvider";
import { flagOn, useFeatureFlags } from "@/lib/features";
import { hideCookOnboard, isSoloKitchenMode, kitchensBrowseHref } from "@/lib/soloKitchen";

export function SiteFooter() {
  const { t } = useLocale();
  const flags = useFeatureFlags();
  const browse = kitchensBrowseHref();
  const showEnroll = !hideCookOnboard();

  const whatsNew = [
    t("common.open") + " / " + t("common.closed"),
    t("discover.yours"),
    t("orders.reorder"),
    t("kitchen.reviews"),
    t("footer.family"),
    t("cart.payWeek"),
    t("cart.pickup"),
  ];

  return (
    <footer className="site-footer">
      <div className="site-footer-panel">
        <div className="site-footer-grid">
          <div className="site-footer-brand">
            <p className="site-footer-kicker">{t("footer.metaPin")}</p>
            <Link href="/" className="brand site-footer-logo">
              LocalMeals
            </Link>
            <p className="site-footer-blurb">{t("footer.blurb")}</p>
          </div>

          <nav className="site-footer-col" aria-label={t("footer.explore")}>
            <h2 className="site-footer-heading">{t("footer.explore")}</h2>
            <ul className="site-footer-links">
              <li>
                <Link href={browse}>{t("footer.discover")}</Link>
              </li>
              {process.env.NODE_ENV !== "production" ? (
                <li>
                  <Link href="/wa">{t("footer.wa")}</Link>
                </li>
              ) : null}
              <li>
                <Link href="/orders">{t("footer.myOrders")}</Link>
              </li>
              {flagOn(flags, "child_pays_enabled") ? (
                <li>
                  <Link href="/family">{t("footer.family")}</Link>
                </li>
              ) : null}
            </ul>
          </nav>

          <nav className="site-footer-col" aria-label={t("footer.account")}>
            <h2 className="site-footer-heading">{t("footer.account")}</h2>
            <ul className="site-footer-links">
              <li>
                <Link href="/login?role=customer">{t("footer.customerLogin")}</Link>
              </li>
              <li>
                <Link href="/login?role=cook">{t("footer.cookLogin")}</Link>
              </li>
              {showEnroll ? (
                <li>
                  <Link href="/cook/onboard">{t("footer.enrollCook")}</Link>
                </li>
              ) : null}
            </ul>
          </nav>

          <nav className="site-footer-col" aria-label={t("footer.legal")}>
            <h2 className="site-footer-heading">{t("footer.legal")}</h2>
            <ul className="site-footer-links">
              <li>
                <Link href="/legal/terms">{t("footer.terms")}</Link>
              </li>
              <li>
                <Link href="/legal/privacy">{t("footer.privacy")}</Link>
              </li>
              <li>
                <Link href="/legal/refunds">{t("footer.refunds")}</Link>
              </li>
              <li>
                <Link href="/legal/delivery">{t("footer.delivery")}</Link>
              </li>
              <li>
                <Link href="/legal/contact">{t("footer.contact")}</Link>
              </li>
            </ul>
          </nav>
        </div>

        <div className="site-footer-whats-new" aria-label={t("footer.whatsNew")}>
          <span className="site-footer-whats-label">{t("footer.whatsNew")}</span>
          {whatsNew.map((label) => (
            <span key={label} className="site-footer-chip">
              {label}
            </span>
          ))}
        </div>

        <div className="site-footer-meta">
          <span>
            {isSoloKitchenMode()
              ? "Cooks keep 100% of food · free delivery · no platform fee"
              : t("footer.metaFee")}
          </span>
        </div>
      </div>
    </footer>
  );
}
