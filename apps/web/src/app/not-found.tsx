"use client";

import Link from "next/link";
import { useLocale } from "@/components/LocaleProvider";
import { kitchensBrowseHref } from "@/lib/soloKitchen";

export default function NotFound() {
  const { t } = useLocale();
  return (
    <main className="status-page">
      <section className="card empty-card" role="status">
        <p className="status-page-code">404</p>
        <h1>{t("notFound.title")}</h1>
        <p className="muted">{t("notFound.body")}</p>
        <div className="status-page-actions">
          <Link href={kitchensBrowseHref()} className="btn">
            {t("footer.discover")}
          </Link>
          <Link href="/" className="btn secondary">
            {t("notFound.home")}
          </Link>
        </div>
      </section>
    </main>
  );
}
