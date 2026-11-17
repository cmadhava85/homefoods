"use client";

import { useState, type FormEvent } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";
import { flagOn, useFeatureFlags } from "@/lib/features";

type Props = {
  publicId: string;
  onDone?: () => void;
  compact?: boolean;
};

export function ReviewForm({ publicId, onDone, compact }: Props) {
  const { t } = useLocale();
  const flags = useFeatureFlags();
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  if (!flagOn(flags, "reviews_enabled")) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await authFetch(`/orders/${publicId}/review`, {
        method: "POST",
        body: JSON.stringify({ rating, comment: comment.trim() || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save review");
      setOk(true);
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (ok) {
    return <p className="ok">{t("review.thanks")}</p>;
  }

  return (
    <form className={compact ? "review-form compact" : "review-form"} onSubmit={submit}>
      <p className="review-form-label">{t("review.rate")}</p>
      <div className="star-row" role="radiogroup" aria-label={t("review.stars")}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            className={`star-btn${rating >= n ? " on" : ""}`}
            onClick={() => setRating(n)}
          >
            ★
          </button>
        ))}
      </div>
      <label className="review-comment-label">
        {t("review.comment")}
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={500}
          rows={compact ? 2 : 3}
          placeholder={t("review.placeholder")}
        />
      </label>
      {err ? <p className="err">{err}</p> : null}
      <button className="btn sm" type="submit" disabled={busy}>
        {busy ? t("review.saving") : t("review.submit")}
      </button>
    </form>
  );
}
