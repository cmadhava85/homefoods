"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch, clearSession } from "@/lib/auth";

export function DeleteAccountPanel() {
  const { t } = useLocale();
  const { setUser } = useAuth();
  const router = useRouter();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onDelete() {
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch("/me/account/delete", {
        method: "POST",
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? res.statusText);
      clearSession();
      setUser(null);
      window.alert(t("account.deleteDone"));
      router.replace("/");
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="account-panel account-danger" aria-labelledby="account-delete-heading">
      <div className="account-panel-head">
        <h2 id="account-delete-heading">{t("account.deleteTitle")}</h2>
        <p className="account-panel-sub">{t("account.deleteHelp")}</p>
      </div>
      <label className="account-field">
        <span className="account-field-label">{t("account.deleteConfirmLabel")}</span>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />
      </label>
      {err ? (
        <p className="err account-field-err" role="alert">
          {err}
        </p>
      ) : null}
      <div className="account-panel-actions">
        <button
          type="button"
          className="btn danger"
          disabled={busy || confirm.trim() !== "DELETE"}
          onClick={() => void onDelete()}
        >
          {busy ? t("account.deleteBusy") : t("account.deleteCta")}
        </button>
      </div>
    </section>
  );
}
