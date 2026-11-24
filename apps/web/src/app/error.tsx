"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useLocale } from "@/components/LocaleProvider";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useLocale();
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="status-page">
      <section className="card empty-card" role="alert">
        <h1>{t("errorPage.title")}</h1>
        <p className="muted">{t("errorPage.body")}</p>
        <div className="status-page-actions">
          <button type="button" className="btn" onClick={reset}>
            {t("errorPage.retry")}
          </button>
          <Link href="/" className="btn secondary">
            {t("notFound.home")}
          </Link>
        </div>
        {error.digest ? (
          <p className="muted status-page-ref">{t("errorPage.ref", { ref: error.digest })}</p>
        ) : null}
      </section>
    </main>
  );
}
