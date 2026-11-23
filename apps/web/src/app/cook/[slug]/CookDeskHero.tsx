"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { authFetch } from "@/lib/auth";

type CookDeskHeroProps = {
  kitchenName: string;
  partnerActive: boolean;
  cookMobile: string;
  intakePaused: boolean;
  togglingPause: boolean;
  onTogglePause: () => void;
  lateOrdersEnabled: boolean;
  latePlatformEnabled: boolean;
  togglingLate: boolean;
  onToggleLate: () => void;
  slug: string;
};

type CapacityToday = {
  used: number;
  remaining: number;
  maxDailyCapacity: number;
};

export function CookDeskHero({
  kitchenName,
  partnerActive,
  cookMobile,
  intakePaused,
  togglingPause,
  onTogglePause,
  lateOrdersEnabled,
  latePlatformEnabled,
  togglingLate,
  onToggleLate,
  slug,
}: CookDeskHeroProps) {
  const { t } = useLocale();
  const [cap, setCap] = useState<CapacityToday | null>(null);
  const [remainingInput, setRemainingInput] = useState("");
  const [trimBusy, setTrimBusy] = useState(false);
  const [trimMsg, setTrimMsg] = useState<string | null>(null);

  async function loadCapacity() {
    try {
      const res = await authFetch(`/cooks/${slug}/capacity-today`);
      const json = await res.json();
      if (!res.ok) return;
      setCap({
        used: Number(json.used) || 0,
        remaining: Number(json.remaining) || 0,
        maxDailyCapacity: Number(json.maxDailyCapacity) || 0,
      });
      setRemainingInput(String(Number(json.remaining) || 0));
    } catch {
      /* desk still usable without capacity strip */
    }
  }

  useEffect(() => {
    void loadCapacity();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when pause flips
  }, [slug, intakePaused]);

  async function saveTrim() {
    const remaining = Number.parseInt(remainingInput, 10);
    if (!Number.isFinite(remaining) || remaining < 0) return;
    setTrimBusy(true);
    setTrimMsg(null);
    try {
      const res = await authFetch(`/cooks/${slug}/capacity-today`, {
        method: "PATCH",
        body: JSON.stringify({ remaining }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not trim capacity");
      setCap({
        used: Number(json.used) || 0,
        remaining: Number(json.remaining) || 0,
        maxDailyCapacity: Number(json.maxDailyCapacity) || 0,
      });
      setRemainingInput(String(Number(json.remaining) || 0));
      setTrimMsg(t("cook.trimCapacitySave"));
    } catch (e) {
      setTrimMsg(e instanceof Error ? e.message : "Could not trim capacity");
    } finally {
      setTrimBusy(false);
    }
  }

  return (
    <header className="cook-hero">
      <p className="chip">{t("cook.desk")}</p>
      <h1>{kitchenName}</h1>
      <p className="muted">
        {partnerActive ? t("cook.partnerActive") : t("cook.selfDelivery")} · WA →{" "}
        <strong>{cookMobile}</strong>
      </p>
      <div className="cook-pause-row">
        <button
          type="button"
          className={`cook-toggle ${intakePaused ? "on tone-warn" : "on tone-go"}`}
          role="switch"
          aria-checked={!intakePaused}
          disabled={togglingPause}
          onClick={onTogglePause}
        >
          <span className="cook-toggle-knob" aria-hidden />
          <span className="cook-toggle-text">
            {intakePaused ? t("cook.pauseOn") : t("cook.pauseOff")}
          </span>
        </button>
        <p className="muted cook-pause-help">{t("cook.pauseTodayHelp")}</p>
      </div>
      <div className="cook-pause-row">
        <button
          type="button"
          className={`cook-toggle ${lateOrdersEnabled && latePlatformEnabled ? "on tone-go" : "on tone-warn"}`}
          role="switch"
          aria-checked={lateOrdersEnabled}
          disabled={togglingLate}
          onClick={onToggleLate}
        >
          <span className="cook-toggle-knob" aria-hidden />
          <span className="cook-toggle-text">
            {lateOrdersEnabled ? t("cook.lateOn") : t("cook.lateOff")}
          </span>
        </button>
        <p className="muted cook-pause-help">
          {!latePlatformEnabled ? t("cook.latePlatformOff") : t("cook.lateHelp")}
        </p>
      </div>
      <div className="cook-trim-row">
        <p className="muted" style={{ margin: "0.5rem 0 0.25rem", fontSize: "0.9rem" }}>
          {t("cook.trimCapacityHelp")}
        </p>
        {cap ? (
          <p className="muted" style={{ margin: "0 0 0.35rem", fontSize: "0.85rem" }}>
            {t("cook.trimCapacityUsed", {
              used: String(cap.used),
              remaining: String(cap.remaining),
              max: String(cap.maxDailyCapacity),
            })}
          </p>
        ) : null}
        <div className="field-row" style={{ gap: "0.5rem", alignItems: "center" }}>
          <label className="muted" style={{ fontSize: "0.9rem" }}>
            {t("cook.trimCapacity")}
            <input
              type="number"
              min={0}
              max={500}
              value={remainingInput}
              onChange={(e) => setRemainingInput(e.target.value)}
              style={{ marginLeft: "0.5rem", width: "4.5rem" }}
              aria-label={t("cook.trimCapacity")}
            />
          </label>
          <button
            type="button"
            className="btn sm"
            disabled={trimBusy}
            onClick={() => void saveTrim()}
          >
            {t("cook.trimCapacitySave")}
          </button>
        </div>
        {trimMsg ? (
          <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
            {trimMsg}
          </p>
        ) : null}
      </div>
    </header>
  );
}
