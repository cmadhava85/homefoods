"use client";

import { useLocale } from "@/components/LocaleProvider";

type CookDeskHeroProps = {
  kitchenName: string;
  partnerActive: boolean;
  cookMobile: string;
  intakePaused: boolean;
  togglingPause: boolean;
  onTogglePause: () => void;
};

export function CookDeskHero({
  kitchenName,
  partnerActive,
  cookMobile,
  intakePaused,
  togglingPause,
  onTogglePause,
}: CookDeskHeroProps) {
  const { t } = useLocale();

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
    </header>
  );
}
