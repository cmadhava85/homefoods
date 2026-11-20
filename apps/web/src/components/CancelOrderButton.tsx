"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";

export function CancelOrderButton({
  publicId,
  checkoutId,
  cancellable,
  cancelRequestable,
  label,
  className,
  onDone,
}: {
  publicId?: string;
  checkoutId?: string;
  cancellable?: boolean;
  cancelRequestable?: boolean;
  label?: string;
  className?: string;
  onDone?: (result: { mode?: string }) => void;
}) {
  const router = useRouter();
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const week = Boolean(checkoutId);
  const asRequest = Boolean(cancelRequestable) && !cancellable;
  if (!cancellable && !asRequest) return null;

  const confirmCopy = week
    ? asRequest
      ? t("orders.confirmCancelRequestWeek", { id: checkoutId ?? "" })
      : t("orders.confirmCancelWeek", { id: checkoutId ?? "" })
    : asRequest
      ? t("orders.confirmCancelRequest", { id: publicId ?? "" })
      : t("orders.confirmCancel", { id: publicId ?? "" });

  async function proceedCancel() {
    const target = checkoutId ?? publicId;
    if (!target) return;
    setBusy(true);
    setErr(null);
    try {
      const path = week
        ? `/checkouts/${checkoutId}/cancel`
        : `/orders/${publicId}/cancel`;
      const res = await authFetch(path, { method: "POST", body: "{}" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Cancel failed");
      setConfirmOpen(false);
      if (onDone) onDone({ mode: json.mode });
      else router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const defaultLabel = week
    ? asRequest
      ? t("orders.requestCancelWeek")
      : t("orders.cancelWeek")
    : asRequest
      ? t("orders.requestCancel")
      : t("orders.cancelOne");

  return (
    <span className={`order-action-slot${err ? " has-err" : ""}${confirmOpen ? " confirm-open" : ""}`}>
      {!confirmOpen ? (
        <button
          className={className ?? "btn secondary"}
          type="button"
          disabled={busy}
          onClick={() => {
            setErr(null);
            setConfirmOpen(true);
          }}
        >
          {label ?? defaultLabel}
        </button>
      ) : (
        <div className="cancel-confirm" role="alertdialog" aria-modal="true" aria-labelledby="cancel-confirm-title">
          <p id="cancel-confirm-title" className="cancel-confirm-copy">
            {confirmCopy}
          </p>
          <div className="cancel-confirm-actions">
            <button
              className="btn secondary"
              type="button"
              disabled={busy}
              onClick={() => setConfirmOpen(false)}
            >
              {t("orders.keepOrder")}
            </button>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => void proceedCancel()}
            >
              {busy ? t("orders.cancelling") : t("orders.confirmCancelYes")}
            </button>
          </div>
        </div>
      )}
      {err ? <p className="err order-action-err">{err}</p> : null}
    </span>
  );
}
