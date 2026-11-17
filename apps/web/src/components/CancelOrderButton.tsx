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
  const [err, setErr] = useState<string | null>(null);

  const week = Boolean(checkoutId);
  const asRequest = Boolean(cancelRequestable) && !cancellable;
  if (!cancellable && !asRequest) return null;

  async function onCancel() {
    const target = checkoutId ?? publicId;
    if (!target) return;
    if (
      !confirm(
        week
          ? asRequest
            ? t("orders.confirmCancelRequestWeek", { id: checkoutId ?? "" })
            : t("orders.confirmCancelWeek", { id: checkoutId ?? "" })
          : asRequest
            ? t("orders.confirmCancelRequest", { id: publicId ?? "" })
            : t("orders.confirmCancel", { id: publicId ?? "" }),
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const path = week
        ? `/checkouts/${checkoutId}/cancel`
        : `/orders/${publicId}/cancel`;
      const res = await authFetch(path, { method: "POST", body: "{}" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Cancel failed");
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
    <span className={`order-action-slot${err ? " has-err" : ""}`}>
      <button
        className={className ?? "btn secondary"}
        type="button"
        disabled={busy}
        onClick={onCancel}
      >
        {busy ? t("orders.cancelling") : (label ?? defaultLabel)}
      </button>
      {err ? <p className="err order-action-err">{err}</p> : null}
    </span>
  );
}
