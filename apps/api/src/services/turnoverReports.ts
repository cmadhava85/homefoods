import { addDaysISO, lineFoodNetPaise, serviceDateISO } from "@localmeals/domain";

/** Order statuses that count toward marketplace GMV (paid pipeline). */
export const GMV_STATUSES = [
  "PAID",
  "COOKING",
  "PACKED",
  "DISPATCHED",
  "DELAYED",
  "DELIVERED",
] as const;

const REFUNDED = "REFUNDED" as const;

export type TurnoverPeriod = "week" | "month" | "year" | "custom";

export function resolveTurnoverRange(input: {
  period: TurnoverPeriod;
  from?: string;
  to?: string;
  asOf?: string;
}): { from: string; to: string; period: TurnoverPeriod; label: string } {
  const asOf = input.asOf ?? serviceDateISO();
  if (input.period === "custom") {
    const from = input.from ?? addDaysISO(asOf, -29);
    const to = input.to ?? asOf;
    if (from > to) throw new Error("from must be on or before to");
    return { from, to, period: "custom", label: `${from} → ${to}` };
  }
  if (input.period === "week") {
    const from = addDaysISO(asOf, -6);
    return { from, to: asOf, period: "week", label: `7 days ending ${asOf}` };
  }
  if (input.period === "month") {
    const [y, m] = asOf.split("-").map(Number) as [number, number];
    const from = `${y}-${String(m).padStart(2, "0")}-01`;
    return {
      from,
      to: asOf,
      period: "month",
      label: `${y}-${String(m).padStart(2, "0")} (through ${asOf})`,
    };
  }
  const y = asOf.slice(0, 4);
  return {
    from: `${y}-01-01`,
    to: asOf,
    period: "year",
    label: `${y} (through ${asOf})`,
  };
}

export type CookTurnoverRow = {
  cookId: string;
  kitchenName: string;
  slugHandle: string;
  onboardingStatus: string;
  isActive: boolean;
  pinCode: string | null;
  payoutBeneficiaryRef: string | null;
  payoutUpiId: string | null;
  /** Paid-pipeline food GMV (after line discounts), paise */
  foodGmvPaise: number;
  deliveryPaise: number;
  platformFeePaise: number;
  /** food + delivery + platform on GMV orders */
  customerChargePaise: number;
  plates: number;
  orderCount: number;
  deliveredOrderCount: number;
  heldOrderCount: number;
  refundedFoodPaise: number;
  refundedOrderCount: number;
  /** Settlement net owed/paid in window */
  settledNetPaise: number;
  /** Platform commission deducted in settlements in window */
  commissionPaise: number;
  settledOrderCount: number;
  manualPaidPaise: number;
  transferCompletedPaise: number;
};

export type PlatformTurnoverSummary = {
  foodGmvPaise: number;
  deliveryPaise: number;
  platformFeePaise: number;
  customerChargePaise: number;
  plates: number;
  orderCount: number;
  refundedFoodPaise: number;
  settledNetPaise: number;
  commissionPaise: number;
  cookCountWithVolume: number;
};

export type TurnoverOrderRow = {
  cookId: string;
  foodPaise: number;
  foodDiscountPaise: number | null;
  deliveryPaise: number;
  platformFeePaise: number;
  qty: number;
  status: string;
  settlementHold: boolean;
};

export type TurnoverSettleRow = {
  cookId: string;
  netPaise: number;
  feesPaise?: number | null;
  orderCount: number;
  status: string;
  manualPaidAt: Date | string | null;
};

export type TurnoverCookMeta = {
  id: string;
  kitchenName: string;
  slugHandle: string;
  onboardingStatus: string;
  isActive: boolean;
  pinCode: string | null;
  payoutBeneficiaryRef: string | null;
  payoutUpiId: string | null;
};

/** Pure aggregate — unit/mutation tested without DB. */
export function aggregateTurnoverFromRows(
  orderRows: TurnoverOrderRow[],
  settleRows: TurnoverSettleRow[],
  cooks: TurnoverCookMeta[],
): { cooks: CookTurnoverRow[]; platform: PlatformTurnoverSummary } {
  const cookById = new Map(cooks.map((c) => [c.id, c]));
  const byCook = new Map<string, CookTurnoverRow>();

  function ensure(cookId: string): CookTurnoverRow {
    let row = byCook.get(cookId);
    if (row) return row;
    const c = cookById.get(cookId);
    row = {
      cookId,
      kitchenName: c?.kitchenName ?? cookId,
      slugHandle: c?.slugHandle ?? "",
      onboardingStatus: c?.onboardingStatus ?? "UNKNOWN",
      isActive: Boolean(c?.isActive),
      pinCode: c?.pinCode ?? null,
      payoutBeneficiaryRef: c?.payoutBeneficiaryRef ?? null,
      payoutUpiId: c?.payoutUpiId ?? null,
      foodGmvPaise: 0,
      deliveryPaise: 0,
      platformFeePaise: 0,
      customerChargePaise: 0,
      plates: 0,
      orderCount: 0,
      deliveredOrderCount: 0,
      heldOrderCount: 0,
      refundedFoodPaise: 0,
      refundedOrderCount: 0,
      settledNetPaise: 0,
      commissionPaise: 0,
      settledOrderCount: 0,
      manualPaidPaise: 0,
      transferCompletedPaise: 0,
    };
    byCook.set(cookId, row);
    return row;
  }

  for (const o of orderRows) {
    const row = ensure(o.cookId);
    const netFood = lineFoodNetPaise(o);
    if (o.status === REFUNDED) {
      row.refundedFoodPaise += netFood;
      row.refundedOrderCount += 1;
      continue;
    }
    if (!(GMV_STATUSES as readonly string[]).includes(o.status)) continue;
    row.foodGmvPaise += netFood;
    row.deliveryPaise += o.deliveryPaise;
    row.platformFeePaise += o.platformFeePaise;
    row.customerChargePaise += netFood + o.deliveryPaise + o.platformFeePaise;
    row.plates += o.qty;
    row.orderCount += 1;
    if (o.status === "DELIVERED") row.deliveredOrderCount += 1;
    if (o.settlementHold) row.heldOrderCount += 1;
  }

  for (const s of settleRows) {
    const row = ensure(s.cookId);
    row.settledNetPaise += s.netPaise;
    row.commissionPaise += s.feesPaise ?? 0;
    row.settledOrderCount += s.orderCount;
    if (s.manualPaidAt || s.status === "MANUAL_PAID") {
      row.manualPaidPaise += s.netPaise;
    }
    if (s.status === "COMPLETED" || s.status === "TRANSFER_COMPLETED") {
      row.transferCompletedPaise += s.netPaise;
    }
  }

  const cooksOut = [...byCook.values()].sort(
    (a, b) => b.foodGmvPaise - a.foodGmvPaise || a.kitchenName.localeCompare(b.kitchenName),
  );

  const platform: PlatformTurnoverSummary = {
    foodGmvPaise: 0,
    deliveryPaise: 0,
    platformFeePaise: 0,
    customerChargePaise: 0,
    plates: 0,
    orderCount: 0,
    refundedFoodPaise: 0,
    settledNetPaise: 0,
    commissionPaise: 0,
    cookCountWithVolume: 0,
  };
  for (const c of cooksOut) {
    platform.foodGmvPaise += c.foodGmvPaise;
    platform.deliveryPaise += c.deliveryPaise;
    platform.platformFeePaise += c.platformFeePaise;
    platform.customerChargePaise += c.customerChargePaise;
    platform.plates += c.plates;
    platform.orderCount += c.orderCount;
    platform.refundedFoodPaise += c.refundedFoodPaise;
    platform.settledNetPaise += c.settledNetPaise;
    platform.commissionPaise += c.commissionPaise;
    if (c.foodGmvPaise > 0 || c.settledNetPaise > 0) platform.cookCountWithVolume += 1;
  }

  return { cooks: cooksOut, platform };
}

export { getTurnoverReport } from "./getTurnoverReport.js";
