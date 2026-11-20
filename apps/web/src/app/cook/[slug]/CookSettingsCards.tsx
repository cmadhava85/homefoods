"use client";

import { useLocale } from "@/components/LocaleProvider";

type CookSettingsCardsProps = {
  mealLabel: string;
  lunchCutoff?: string;
  deliveryWindow?: string;
  hour: number;
  minute: number;
  onHourChange: (value: number) => void;
  onMinuteChange: (value: number) => void;
  onSaveCutoff: () => void;
  winStartH: number;
  winStartM: number;
  winEndH: number;
  winEndM: number;
  onWinStartHChange: (value: number) => void;
  onWinStartMChange: (value: number) => void;
  onWinEndHChange: (value: number) => void;
  onWinEndMChange: (value: number) => void;
  onSaveDeliveryWindow: () => void;
  weekPct: number;
  weekMinDays: number;
  weekPlatformOn: boolean;
  onWeekPctChange: (value: number) => void;
  onWeekMinDaysChange: (value: number) => void;
  onSaveWeekDiscount: () => void;
  offerCookDelivery: boolean;
  pickupOn: boolean;
  pickupPlatformOn: boolean;
  offerCustomerArrange: boolean;
  pickupLandmark: string;
  savingFulfillment: boolean;
  savingPickup: boolean;
  onToggleOfferCookDelivery: () => void;
  onTogglePickup: () => void;
  onToggleOfferCustomerArrange: () => void;
  onPickupLandmarkChange: (value: string) => void;
  onSaveFulfillmentOffers: () => void;
  partnerActive: boolean;
  deliveryType: "SELF" | "PARTNER";
  partnerPlatformOn: boolean;
};

export function CookSettingsCards({
  mealLabel,
  lunchCutoff,
  deliveryWindow,
  hour,
  minute,
  onHourChange,
  onMinuteChange,
  onSaveCutoff,
  winStartH,
  winStartM,
  winEndH,
  winEndM,
  onWinStartHChange,
  onWinStartMChange,
  onWinEndHChange,
  onWinEndMChange,
  onSaveDeliveryWindow,
  weekPct,
  weekMinDays,
  weekPlatformOn,
  onWeekPctChange,
  onWeekMinDaysChange,
  onSaveWeekDiscount,
  offerCookDelivery,
  pickupOn,
  pickupPlatformOn,
  offerCustomerArrange,
  pickupLandmark,
  savingFulfillment,
  savingPickup,
  onToggleOfferCookDelivery,
  onTogglePickup,
  onToggleOfferCustomerArrange,
  onPickupLandmarkChange,
  onSaveFulfillmentOffers,
  partnerActive,
  deliveryType,
  partnerPlatformOn,
}: CookSettingsCardsProps) {
  const { t } = useLocale();

  return (
    <>
      <h2 style={{ marginTop: "0.5rem" }}>{t("cook.kitchenSettings")}</h2>

      <div className="card cook-settings-card">
        <div className="cook-setting-row">
          <div className="cook-setting-copy">
            <strong>
              {mealLabel} · {t("cook.cutoff")}
            </strong>
            <span className="muted">{lunchCutoff ?? "08:00"}</span>
          </div>
          <div className="cook-setting-controls">
            <label className="cook-time-field">
              <span className="cook-time-label">{t("cook.cutoff")}</span>
              <div className="cook-time-pair">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={String(hour).padStart(2, "0")}
                  onChange={(e) => onHourChange(Number(e.target.value))}
                  aria-label="Hour"
                />
                <span aria-hidden>:</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={String(minute).padStart(2, "0")}
                  onChange={(e) => onMinuteChange(Number(e.target.value))}
                  aria-label="Minute"
                />
              </div>
            </label>
            <button className="btn sm cook-setting-save" type="button" onClick={onSaveCutoff}>
              {t("cook.save")}
            </button>
          </div>
        </div>

        <div className="cook-setting-row">
          <div className="cook-setting-copy">
            <strong>
              {mealLabel} · {t("cook.deliveryEta")}
            </strong>
            <span className="muted">{deliveryWindow ?? "12:00–13:00"}</span>
          </div>
          <div className="cook-setting-controls cook-setting-controls-eta">
            <label className="cook-time-field">
              <span className="cook-time-label">{t("cook.from")}</span>
              <div className="cook-time-pair">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={String(winStartH).padStart(2, "0")}
                  onChange={(e) => onWinStartHChange(Number(e.target.value))}
                  aria-label="Start hour"
                />
                <span aria-hidden>:</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={String(winStartM).padStart(2, "0")}
                  onChange={(e) => onWinStartMChange(Number(e.target.value))}
                  aria-label="Start minute"
                />
              </div>
            </label>
            <label className="cook-time-field">
              <span className="cook-time-label">{t("cook.to")}</span>
              <div className="cook-time-pair">
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={String(winEndH).padStart(2, "0")}
                  onChange={(e) => onWinEndHChange(Number(e.target.value))}
                  aria-label="End hour"
                />
                <span aria-hidden>:</span>
                <input
                  type="number"
                  min={0}
                  max={59}
                  value={String(winEndM).padStart(2, "0")}
                  onChange={(e) => onWinEndMChange(Number(e.target.value))}
                  aria-label="End minute"
                />
              </div>
            </label>
            <button
              className="btn sm cook-setting-save"
              type="button"
              onClick={onSaveDeliveryWindow}
            >
              {t("cook.saveEta")}
            </button>
          </div>
        </div>
      </div>

      <div className="card cook-pref-card">
        <div className="cook-pref-head">
          <div>
            <p className="cook-menu-kicker">{t("cook.kitchenSettings")}</p>
            <strong>{t("cook.weekDiscount")}</strong>
          </div>
          <span className={`chip ${weekPct > 0 ? "tone-done" : "tone-neutral"}`}>
            {weekPct > 0 ? `${weekPct}%` : t("cook.off")}
          </span>
        </div>
        <p className="cook-pref-help">{t("cook.weekDiscountHelp")}</p>
        {!weekPlatformOn ? (
          <p className="cook-pref-banner">{t("cook.weekDiscountPaused")}</p>
        ) : null}
        <div className="cook-pref-controls">
          <label className="cook-pref-field">
            <span className="cook-time-label">%</span>
            <div className="cook-pref-input">
              <input
                type="number"
                min={0}
                max={15}
                value={weekPct}
                onChange={(e) => onWeekPctChange(Number(e.target.value))}
              />
            </div>
          </label>
          <label className="cook-pref-field">
            <span className="cook-time-label">{t("cook.minDays")}</span>
            <div className="cook-pref-input">
              <input
                type="number"
                min={2}
                max={14}
                value={weekMinDays}
                onChange={(e) => onWeekMinDaysChange(Number(e.target.value))}
              />
            </div>
          </label>
          <button className="btn sm cook-setting-save" type="button" onClick={onSaveWeekDiscount}>
            {t("cook.save")}
          </button>
        </div>
      </div>

      <div className="card cook-pref-card">
        <div className="cook-pref-head">
          <div>
            <p className="cook-menu-kicker">{t("cook.kitchenSettings")}</p>
            <strong>{t("cook.fulfillmentTitle")}</strong>
          </div>
        </div>
        <p className="cook-pref-help">{t("cook.fulfillmentHelp")}</p>
        <button
          type="button"
          className={`cook-toggle ${offerCookDelivery ? "on" : ""}`}
          role="switch"
          aria-checked={offerCookDelivery}
          onClick={onToggleOfferCookDelivery}
        >
          <span className="cook-toggle-knob" aria-hidden />
          <span className="cook-toggle-text">{t("cook.offerCookDelivery")}</span>
        </button>
        <button
          type="button"
          className={`cook-toggle ${pickupOn ? "on" : ""}`}
          role="switch"
          aria-checked={pickupOn}
          disabled={!pickupPlatformOn}
          onClick={onTogglePickup}
        >
          <span className="cook-toggle-knob" aria-hidden />
          <span className="cook-toggle-text">{t("cook.pickupOffer")}</span>
        </button>
        {!pickupPlatformOn ? (
          <p className="cook-pref-banner">{t("cook.pickupPlatformOff")}</p>
        ) : null}
        <button
          type="button"
          className={`cook-toggle ${offerCustomerArrange ? "on" : ""}`}
          role="switch"
          aria-checked={offerCustomerArrange}
          onClick={onToggleOfferCustomerArrange}
        >
          <span className="cook-toggle-knob" aria-hidden />
          <span className="cook-toggle-text">{t("cook.offerCustomerArrange")}</span>
        </button>
        <label className="cook-pref-field cook-pref-field-full">
          <span className="cook-time-label">{t("cook.pickupLandmark")}</span>
          <input
            className="cook-pref-text"
            type="text"
            value={pickupLandmark}
            maxLength={300}
            placeholder={t("cook.pickupLandmarkPlaceholder")}
            onChange={(e) => onPickupLandmarkChange(e.target.value)}
          />
        </label>
        <p className="cook-pref-help">{t("cook.pickupHelp")}</p>
        <button
          className="btn cook-setting-save cook-pref-save"
          type="button"
          disabled={savingFulfillment || savingPickup}
          onClick={onSaveFulfillmentOffers}
        >
          {savingFulfillment ? t("cook.sending") : t("cook.save")}
        </button>
      </div>

      <div className="card cook-pref-card">
        <div className="cook-pref-head">
          <div>
            <p className="cook-menu-kicker">{t("cook.partnerDelivery")}</p>
            <strong>
              {partnerActive
                ? t("cook.partnerActive")
                : deliveryType === "PARTNER"
                  ? t("admin.deliveryPartner")
                  : t("cook.selfDelivery")}
            </strong>
          </div>
          <span className={`chip ${partnerActive ? "tone-done" : "tone-neutral"}`}>
            {partnerActive ? t("cook.on") : t("cook.off")}
          </span>
        </div>
        <p className="cook-pref-help">{t("cook.partnerDeliveryHelp")}</p>
        {!partnerPlatformOn ? (
          <p className="cook-pref-banner">{t("cook.partnerNeedsFlag")}</p>
        ) : deliveryType !== "PARTNER" ? (
          <p className="cook-pref-banner">{t("cook.partnerSelfMode")}</p>
        ) : null}
      </div>
    </>
  );
}
