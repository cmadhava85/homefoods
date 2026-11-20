"use client";

import type { FulfillmentMode } from "@/lib/fulfillment";
import { showFulfillmentChooser, type FulfillmentOffersView } from "@/lib/fulfillment";
import { useLocale } from "@/components/LocaleProvider";

type Props = {
  value: FulfillmentMode;
  onChange: (mode: FulfillmentMode) => void;
  offers?: FulfillmentOffersView | null;
  pickupAvailable?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

export function FulfillmentChooser({
  value,
  onChange,
  offers,
  pickupAvailable = false,
  className = "seg kitchen-fulfill-seg",
  style,
}: Props) {
  const { t } = useLocale();
  const cookDeliveryOk = offers?.cookDelivery !== false;
  const pickupOk = Boolean(pickupAvailable || offers?.pickup);
  const arrangeOk = Boolean(offers?.customerArrange);

  if (!showFulfillmentChooser(offers, pickupAvailable)) return null;

  return (
    <div className={className} role="group" aria-label="Fulfillment" style={style}>
      {cookDeliveryOk ? (
        <button
          type="button"
          className={value === "DELIVERY" ? "on" : ""}
          onClick={() => onChange("DELIVERY")}
        >
          {t("cart.delivery")}
        </button>
      ) : null}
      {pickupOk ? (
        <button
          type="button"
          className={value === "PICKUP" ? "on" : ""}
          onClick={() => onChange("PICKUP")}
        >
          {t("cart.pickup")}
        </button>
      ) : null}
      {arrangeOk ? (
        <button
          type="button"
          className={value === "CUSTOMER_ARRANGE" ? "on" : ""}
          onClick={() => onChange("CUSTOMER_ARRANGE")}
        >
          {t("cart.customerArrange")}
        </button>
      ) : null}
    </div>
  );
}
