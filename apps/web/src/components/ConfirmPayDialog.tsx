"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { GATEWAY_FEE_BPS, priceCheckoutLines } from "@localmeals/domain";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { flagOn, useFeatureFlags } from "@/lib/features";
import { formatInrAmount } from "@/lib/money";

export type ConfirmPayChoice = { useCredit: boolean; paymentMethod: "LINK" | "UPI_QR" };

export type ConfirmPaySummary = {
  rows: Array<{ key: string; label: string; amountPaise: number }>;
  /** Per-line totals before credit/fee, in checkout order (same split the API uses). */
  lineBasesPaise: number[];
  foodPaise: number;
  discountPaise: number;
  deliveryPaise: number;
  platformPaise: number;
  fulfillmentMode: string;
  cutoff?: string | null;
  /** Child Pays: the payer's phone pays, so the customer's credit is not offered. */
  childPays?: boolean;
};

/**
 * Confirm-before-pay: full price breakdown (incl. convenience fee and credit), payment method and
 * cut-off / cancellation note. Amounts mirror the API (same domain helpers); the API stays
 * authoritative and the pay page shows the final charge.
 */
export function ConfirmPayDialog({
  summary,
  busy,
  onConfirm,
  onCancel,
}: {
  summary: ConfirmPaySummary;
  busy?: boolean;
  onConfirm: (choice: ConfirmPayChoice) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const flags = useFeatureFlags();
  const creditOn = flagOn(flags, "wallet_credit_enabled") && !summary.childPays;
  const feeOn = flagOn(flags, "convenience_fee_enabled");
  const qrOn = flagOn(flags, "upi_qr_pickup_enabled") && summary.fulfillmentMode === "PICKUP";

  const [balance, setBalance] = useState(0);
  const [useCredit, setUseCredit] = useState(true);
  const [method, setMethod] = useState<"LINK" | "UPI_QR">(qrOn ? "UPI_QR" : "LINK");

  useEffect(() => {
    if (!creditOn) return;
    authFetch("/me/credits")
      .then((r) => (r.ok ? r.json() : { balancePaise: 0 }))
      .then((j) => setBalance(Number(j.balancePaise ?? 0)))
      .catch(() => setBalance(0));
  }, [creditOn]);

  const effectiveMethod = qrOn ? method : "LINK";
  const bps = feeOn ? GATEWAY_FEE_BPS[effectiveMethod] : 0;
  const priced = useMemo(
    () =>
      priceCheckoutLines(summary.lineBasesPaise, {
        creditAvailablePaise: creditOn && useCredit ? balance : 0,
        feeBps: bps,
      }),
    [summary.lineBasesPaise, creditOn, useCredit, balance, bps],
  );
  const fee = priced.reduce((s, p) => s + p.convenienceFeePaise, 0);
  const credit = priced.reduce((s, p) => s + p.creditAppliedPaise, 0);
  const toPay = priced.reduce((s, p) => s + p.gatewayPaise, 0);

  return (
    <div className="confirm-pay-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <section
        className="card confirm-pay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-pay-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-pay-title">{t("confirm.title")}</h2>
        <ul className="confirm-pay-rows">
          {summary.rows.map((r) => (
            <li key={r.key}>
              <span>{r.label}</span>
              <span>₹{formatInrAmount(r.amountPaise)}</span>
            </li>
          ))}
        </ul>
        <dl className="confirm-pay-sum">
          {summary.discountPaise > 0 ? (
            <div>
              <dt>{t("confirm.weekOff")}</dt>
              <dd>−₹{formatInrAmount(summary.discountPaise)}</dd>
            </div>
          ) : null}
          <div>
            <dt>{t("confirm.delivery")}</dt>
            <dd>₹{formatInrAmount(summary.deliveryPaise)}</dd>
          </div>
          {summary.platformPaise > 0 ? (
            <div>
              <dt>{t("confirm.platform")}</dt>
              <dd>₹{formatInrAmount(summary.platformPaise)}</dd>
            </div>
          ) : null}
          {fee > 0 ? (
            <div>
              <dt>
                {t("confirm.fee")}
                <small className="muted">
                  {t("confirm.feeHelp", { pct: `${(bps / 100).toFixed(2)}%` })}
                </small>
              </dt>
              <dd>₹{formatInrAmount(fee)}</dd>
            </div>
          ) : null}
          {credit > 0 ? (
            <div>
              <dt>{t("confirm.credit")}</dt>
              <dd>−₹{formatInrAmount(credit)}</dd>
            </div>
          ) : null}
          <div className="confirm-pay-total">
            <dt>{t("confirm.total")}</dt>
            <dd>₹{formatInrAmount(toPay)}</dd>
          </div>
        </dl>

        {creditOn && balance > 0 ? (
          <label className="confirm-pay-check">
            <input type="checkbox" checked={useCredit} onChange={(e) => setUseCredit(e.target.checked)} />
            {t("confirm.useCredit", { amount: formatInrAmount(balance) })}
          </label>
        ) : null}

        {qrOn && toPay > 0 ? (
          <fieldset className="confirm-pay-method">
            <legend>{t("confirm.payMethod")}</legend>
            <label>
              <input type="radio" name="pay-method" checked={method === "UPI_QR"} onChange={() => setMethod("UPI_QR")} />
              {t("confirm.payQr")}
            </label>
            <label>
              <input type="radio" name="pay-method" checked={method === "LINK"} onChange={() => setMethod("LINK")} />
              {t("confirm.payLink")}
            </label>
          </fieldset>
        ) : null}

        {summary.cutoff ? <p className="muted">{t("confirm.cutoff", { time: summary.cutoff })}</p> : null}
        <p className="muted">
          <Link href="/legal/refunds" target="_blank">
            {t("confirm.policy")}
          </Link>
        </p>

        <div className="confirm-pay-actions">
          <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>
            {t("confirm.back")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onConfirm({ useCredit: creditOn ? useCredit : false, paymentMethod: effectiveMethod })}
          >
            {toPay === 0 ? t("confirm.ctaCredit") : t("confirm.cta", { amount: formatInrAmount(toPay) })}
          </button>
        </div>
      </section>
    </div>
  );
}
