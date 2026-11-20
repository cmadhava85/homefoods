"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { useLocale } from "./LocaleProvider";
import { flagOn, useFeatureFlags } from "@/lib/features";
import { loginPath } from "@/lib/auth";
import { adminHref, isAdminUiPath } from "@/lib/adminPath";
import { kitchensBrowseHref } from "@/lib/soloKitchen";
import type { Locale } from "@localmeals/i18n";

function navClass(href: string, pathname: string) {
  const on =
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);
  return on ? "active" : undefined;
}

export function SiteHeader() {
  const { user, ready, logout } = useAuth();
  const { locale, setLocale, t } = useLocale();
  const flags = useFeatureFlags();
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const browse = kitchensBrowseHref();

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="brand" aria-label="LocalMeals home">
          LocalMeals
        </Link>

        <nav className="site-nav" aria-label="Main">
          {!ready ? (
            <span className="site-nav-placeholder" aria-hidden />
          ) : user?.role === "COOK" && user.cookSlug ? (
            <>
              <Link href={`/cook/${user.cookSlug}`} className={navClass(`/cook/${user.cookSlug}`, pathname)}>
                {t("nav.desk")}
              </Link>
              <Link href={browse} className={navClass(browse, pathname)}>
                {t("nav.kitchens")}
              </Link>
            </>
          ) : user?.role === "ADMIN" ? (
            <>
              <Link href={adminHref()} className={isAdminUiPath(pathname) ? "active" : undefined}>
                {t("nav.admin")}
              </Link>
              <Link href={browse} className={navClass(browse, pathname)}>
                {t("nav.kitchens")}
              </Link>
            </>
          ) : (
            <>
              <Link href={browse} className={navClass(browse, pathname)}>
                {t("nav.discover")}
              </Link>
              <Link href="/orders" className={navClass("/orders", pathname)}>
                {t("nav.orders")}
              </Link>
              {flagOn(flags, "child_pays_enabled") ? (
                <Link href="/family" className={navClass("/family", pathname)}>
                  {t("nav.family")}
                </Link>
              ) : null}
              <Link href="/account" className={navClass("/account", pathname)}>
                {t("nav.account")}
              </Link>
            </>
          )}
        </nav>

        <div className="site-header-auth">
          <div className="lang-toggle" role="group" aria-label={t("nav.language")}>
            {(["en", "ta"] as Locale[]).map((code) => (
              <button
                key={code}
                type="button"
                className={locale === code ? "on" : ""}
                aria-pressed={locale === code}
                onClick={() => setLocale(code)}
              >
                {t(code === "en" ? "nav.lang.en" : "nav.lang.ta")}
              </button>
            ))}
          </div>
          {!ready ? null : !user ? (
            <>
              <Link href="/login?role=customer" className="btn sm">
                {t("nav.signIn")}
              </Link>
              <Link href="/login?role=cook" className="btn sm secondary site-header-ops">
                {t("nav.cookLogin")}
              </Link>
            </>
          ) : (
            <>
              <span className="site-header-role muted" title={user.mobile}>
                {user.role === "CUSTOMER"
                  ? user.fullName && user.fullName !== "Guest"
                    ? user.fullName
                    : t("nav.customer")
                  : user.role === "COOK"
                    ? t("nav.cook")
                    : t("nav.admin")}
              </span>
              <button
                className="btn sm secondary"
                type="button"
                onClick={() => router.push(loginPath(user.role, pathname, true))}
              >
                {t("nav.switchAccount")}
              </button>
              <button className="btn sm secondary" type="button" onClick={() => void logout()}>
                {t("nav.signOut")}
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
