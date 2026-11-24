"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { readLastRequestRef } from "@/lib/requestRef";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useLocale();
  const [requestRef, setRequestRef] = useState<string | null>(null);
  useEffect(() => {
    console.error(error);
    setRequestRef(readLastRequestRef());
  }, [error]);

  const refs = [error.digest, requestRef].filter(Boolean) as string[];

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
        {refs.length ? (
          <p className="muted status-page-ref">
            {t("errorPage.ref", { ref: refs.join(" · ") })}
          </p>
        ) : null}
      </section>
    </main>
  );
}
