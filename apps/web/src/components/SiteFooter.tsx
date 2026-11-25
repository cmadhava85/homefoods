"use client";

import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import { useLocale } from "@/components/LocaleProvider";
import { flagOn, useFeatureFlags, usePlatformFeePaise } from "@/lib/features";
import { hideCookOnboard, isSoloKitchenMode, kitchensBrowseHref } from "@/lib/soloKitchen";

export function SiteFooter() {
  const { t } = useLocale();
  const { user } = useAuth();
  const flags = useFeatureFlags();
  const platformFeePaise = usePlatformFeePaise();
  const browse = kitchensBrowseHref();
  const showEnroll = !hideCookOnboard();
  const customer = user?.role === "CUSTOMER";
  const ordersHref = customer ? "/orders" : "/login?role=customer&next=/orders";
  const familyHref = customer ? "/family" : "/login?role=customer&next=/family";

  // Only advertise features that are switched on; chips with a page are links.
  const whatsNew: Array<{ label: string; href?: string }> = [
    flagOn(flags, "kitchen_follow_enabled") ? { label: t("discover.yours"), href: browse } : null,
    { label: t("orders.reorder"), href: ordersHref },
    flagOn(flags, "reviews_enabled") ? { label: t("kitchen.reviews") } : null,
    flagOn(flags, "child_pays_enabled") ? { label: t("footer.family"), href: familyHref } : null,
    flagOn(flags, "week_discount_enabled") ? { label: t("cart.payWeek") } : null,
    flagOn(flags, "pickup_enabled") ? { label: t("cart.pickup") } : null,
  ].filter((item): item is { label: string; href?: string } => item !== null);

  return (
    <footer className="site-footer">
      <div className="site-footer-panel">
        <div className="site-footer-grid">
          <div className="site-footer-brand">
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
                <Link href={ordersHref}>{t("footer.myOrders")}</Link>
              </li>
              {flagOn(flags, "child_pays_enabled") ? (
                <li>
                  <Link href={familyHref}>{t("footer.family")}</Link>
                </li>
              ) : null}
            </ul>
          </nav>

          <nav className="site-footer-col" aria-label={t("footer.account")}>
            <h2 className="site-footer-heading">{t("footer.account")}</h2>
            <ul className="site-footer-links">
              {customer ? (
                <li>
                  <Link href="/account">{t("nav.account")}</Link>
                </li>
              ) : user?.role === "COOK" && user.cookSlug ? (
                <li>
                  <Link href={`/cook/${user.cookSlug}`}>{t("nav.desk")}</Link>
                </li>
              ) : (
                <>
                  <li>
                    <Link href="/login?role=customer">{t("footer.customerLogin")}</Link>
                  </li>
                  <li>
                    <Link href="/login?role=cook">{t("footer.cookLogin")}</Link>
                  </li>
                </>
              )}
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
          {whatsNew.map(({ label, href }) =>
            href ? (
              <Link key={label} href={href} className="site-footer-chip">
                {label}
              </Link>
            ) : (
              <span key={label} className="site-footer-chip">
                {label}
              </span>
            ),
          )}
        </div>

        <div className="site-footer-meta">
          <span>
            {isSoloKitchenMode()
              ? `Home-cooked by one kitchen · free delivery · ${
                  platformFeePaise > 0
                    ? `₹${(platformFeePaise / 100).toFixed(0)} platform fee per checkout`
                    : "no platform fee"
                }`
              : t("footer.metaFee")}
          </span>
        </div>
      </div>
    </footer>
  );
}
