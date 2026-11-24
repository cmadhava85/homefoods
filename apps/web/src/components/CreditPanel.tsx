"use client";

import { useEffect, useState } from "react";
import type { MsgKey } from "@localmeals/i18n";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { flagOn, useFeatureFlags } from "@/lib/features";
import { formatInrAmount } from "@/lib/money";

type Credits = {
  balancePaise: number;
  entries: Array<{ id: number; amountPaise: number; reason: string; createdAt: string }>;
};

const REASON_KEYS = new Set(["REFUND_TO_CREDIT", "REFUND_CREDIT_PART", "ORDER_PAID"]);

export function CreditPanel() {
  const { t, locale } = useLocale();
  const flags = useFeatureFlags();
  const [data, setData] = useState<Credits | null>(null);
  const on = flagOn(flags, "wallet_credit_enabled");

  useEffect(() => {
    if (!on) return;
    authFetch("/me/credits")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setData(j))
      .catch(() => setData(null));
  }, [on]);

  if (!on || !data) return null;
  if (data.balancePaise === 0 && data.entries.length === 0) return null;

  return (
    <section className="account-panel" aria-labelledby="account-credit-heading">
      <div className="account-panel-head">
        <h2 id="account-credit-heading">{t("account.creditTitle")}</h2>
        <p className="account-panel-sub">{t("account.creditHelp")}</p>
      </div>
      <p className="credit-balance">₹{formatInrAmount(data.balancePaise)}</p>
      {data.entries.length ? (
        <ul className="credit-entries">
          {data.entries.slice(0, 10).map((e) => (
            <li key={e.id}>
              <span>
                {REASON_KEYS.has(e.reason)
                  ? t(`account.creditReason.${e.reason}` as MsgKey)
                  : e.reason}
                <small className="muted">
                  {" · "}
                  {new Date(e.createdAt).toLocaleDateString(locale === "ta" ? "ta-IN" : "en-IN")}
                </small>
              </span>
              <span className={e.amountPaise < 0 ? "credit-debit" : "credit-credit"}>
                {e.amountPaise < 0 ? "−" : "+"}₹{formatInrAmount(Math.abs(e.amountPaise))}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t("account.creditEmpty")}</p>
      )}
    </section>
  );
}
