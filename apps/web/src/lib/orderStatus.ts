import type { MsgKey } from "@localmeals/i18n";

type StatusOpts = {
  childPays?: boolean;
  roleOnOrder?: "CUSTOMER" | "PAYER";
  fulfillmentMode?: string | null;
};

type Translate = (key: MsgKey, params?: Record<string, string | number>) => string;

/** Customer-facing labels — keep kitchen jargon off the happy path. */
export function customerStatusLabelKey(status: string, opts?: StatusOpts): MsgKey {
  const pickup = opts?.fulfillmentMode === "PICKUP";
  switch (status) {
    case "PENDING_APPROVAL":
      return "status.label.waitingCook";
    case "AWAITING_PAYMENT":
      if (opts?.childPays && opts.roleOnOrder === "PAYER") return "status.label.familyYourTurn";
      if (opts?.childPays) return "status.label.waitingFamily";
      return "status.label.payNow";
    case "CONFIRMING_PAYMENT":
      return "status.label.confirming";
    case "PAID":
      return "status.label.kitchenQueue";
    case "COOKING":
      return "status.label.cooking";
    case "PACKED":
      return pickup ? "status.label.readyPickup" : "status.label.packed";
    case "ASSIGNING_RIDER":
      return "status.label.assigningRider";
    case "DISPATCHED":
      return "status.label.onTheWay";
    case "DELAYED":
      return "status.label.delayed";
    case "DELIVERED":
      return pickup ? "status.label.pickedUp" : "status.label.delivered";
    case "CANCEL_REQUESTED":
      return "status.label.cancelRequested";
    case "CANCELLED":
      return "status.label.cancelled";
    case "FAILED":
      return "status.label.payFailed";
    case "REFUNDED":
      return "status.label.refunded";
    case "RETURNED_TO_KITCHEN":
      return "status.label.returned";
    case "LOGISTICS_EXCEPTION":
      return "status.label.deliveryIssue";
    default:
      return "status.head.confirmed";
  }
}

export function customerStatusLabel(t: Translate, status: string, opts?: StatusOpts): string {
  if (
    ![
      "PENDING_APPROVAL",
      "AWAITING_PAYMENT",
      "CONFIRMING_PAYMENT",
      "PAID",
      "COOKING",
      "PACKED",
      "ASSIGNING_RIDER",
      "DISPATCHED",
      "DELAYED",
      "DELIVERED",
      "CANCEL_REQUESTED",
      "CANCELLED",
      "FAILED",
      "REFUNDED",
      "RETURNED_TO_KITCHEN",
      "LOGISTICS_EXCEPTION",
    ].includes(status)
  ) {
    return status;
  }
  return t(customerStatusLabelKey(status, opts));
}

export function customerStatusHeadline(t: Translate, status: string, opts?: StatusOpts): string {
  const pickup = opts?.fulfillmentMode === "PICKUP";
  switch (status) {
    case "PENDING_APPROVAL":
      return t("status.head.lateSent");
    case "AWAITING_PAYMENT":
      if (opts?.childPays && opts.roleOnOrder === "PAYER") return t("status.head.yourTurn");
      if (opts?.childPays) return t("status.head.waitingFamily");
      return t("status.head.completePay");
    case "COOKING":
      return t("status.head.cooking");
    case "PACKED":
      return pickup ? t("status.head.readyPickup") : t("status.head.packedReady");
    case "ASSIGNING_RIDER":
      return t("status.label.assigningRider");
    case "DISPATCHED":
      return t("status.head.onTheWay");
    case "DELIVERED":
      return pickup ? t("status.head.pickedUp") : t("status.head.delivered");
    case "CANCEL_REQUESTED":
      return t("status.head.cancelRequested");
    case "CANCELLED":
      return t("status.head.cancelled");
    case "FAILED":
      return t("status.head.payFailed");
    case "REFUNDED":
      return t("status.head.refunded");
    default:
      return t("status.head.confirmed");
  }
}

export function customerStatusBlurb(t: Translate, status: string, opts?: StatusOpts): string {
  const pickup = opts?.fulfillmentMode === "PICKUP";
  switch (status) {
    case "PENDING_APPROVAL":
      return t("status.blurb.late");
    case "AWAITING_PAYMENT":
      if (opts?.childPays && opts.roleOnOrder === "PAYER") return t("status.blurb.familyPayer");
      if (opts?.childPays) return t("status.blurb.familyWait");
      return t("status.blurb.payUpi");
    case "PAID":
      return pickup ? t("status.blurb.paidPickup") : t("status.blurb.paidQueue");
    case "COOKING":
      return t("status.blurb.cooking");
    case "PACKED":
      return pickup ? t("status.blurb.packedPickup") : t("status.blurb.packedDelivery");
    case "ASSIGNING_RIDER":
      return t("status.blurb.assigningRider");
    case "DISPATCHED":
      return t("status.blurb.onWay");
    case "DELIVERED":
      return pickup ? t("status.blurb.collected") : t("status.blurb.enjoy");
    case "CANCEL_REQUESTED":
      return t("status.blurb.cancelRequested");
    case "CANCELLED":
      return t("status.blurb.cancelled");
    case "FAILED":
      return t("status.blurb.failed");
    case "REFUNDED":
      return t("status.blurb.refunded");
    default:
      return customerStatusLabel(t, status, opts);
  }
}

export type StatusTone = "neutral" | "warn" | "progress" | "go" | "done" | "bad";

export function statusTone(status: string): StatusTone {
  switch (status) {
    case "AWAITING_PAYMENT":
    case "CONFIRMING_PAYMENT":
    case "PENDING_APPROVAL":
    case "CANCEL_REQUESTED":
      return "warn";
    case "PAID":
    case "COOKING":
    case "PACKED":
    case "ASSIGNING_RIDER":
      return "progress";
    case "DISPATCHED":
    case "DELAYED":
      return "go";
    case "DELIVERED":
      return "done";
    case "CANCELLED":
    case "FAILED":
      return "bad";
    case "REFUNDED":
      return "warn";
    default:
      return "neutral";
  }
}

const PROGRESS_DELIVERY = ["PAID", "COOKING", "PACKED", "DISPATCHED", "DELIVERED"] as const;
const PROGRESS_PARTNER = [
  "PAID",
  "COOKING",
  "PACKED",
  "ASSIGNING_RIDER",
  "DISPATCHED",
  "DELIVERED",
] as const;
const PROGRESS_PICKUP = ["PAID", "COOKING", "PACKED", "DELIVERED"] as const;

function progressLane(
  fulfillmentMode?: string | null,
  logisticsMode?: string | null,
  status?: string,
): readonly string[] {
  if (fulfillmentMode === "PICKUP") return PROGRESS_PICKUP;
  if (logisticsMode === "PARTNER" || status === "ASSIGNING_RIDER") return PROGRESS_PARTNER;
  return PROGRESS_DELIVERY;
}

export function progressIndex(
  status: string,
  fulfillmentMode?: string | null,
  logisticsMode?: string | null,
): number {
  const steps = progressLane(fulfillmentMode, logisticsMode, status);
  if (status === "DELAYED") {
    const delayedAt = steps.indexOf("DISPATCHED");
    return delayedAt >= 0 ? delayedAt : steps.indexOf("PACKED");
  }
  return steps.indexOf(status);
}

export function progressSteps(
  t: Translate,
  status: string,
  fulfillmentMode?: string | null,
  logisticsMode?: string | null,
) {
  const steps = progressLane(fulfillmentMode, logisticsMode, status);
  const active = progressIndex(status, fulfillmentMode, logisticsMode);
  return steps.map((step, i) => ({
    key: step,
    label: customerStatusLabel(t, step, { fulfillmentMode }),
    state: active < 0 ? "idle" : i < active ? "done" : i === active ? "current" : "todo",
  }));
}

/** Next primary action for cook desk stop cards. */
export function cookNextAction(
  t: Translate,
  status: string,
  fulfillmentMode?: string | null,
): {
  label: string;
  pathSuffix: "cooking" | "pack" | "dispatch" | "rider-assigned" | "delivered";
} | null {
  const pickup = fulfillmentMode === "PICKUP";
  switch (status) {
    case "PAID":
      return { label: t("status.cook.startCooking"), pathSuffix: "cooking" };
    case "COOKING":
      return { label: t("status.cook.markPacked"), pathSuffix: "pack" };
    case "PACKED":
      return pickup
        ? { label: t("status.cook.markPickedUp"), pathSuffix: "delivered" }
        : { label: t("status.cook.dispatch"), pathSuffix: "dispatch" };
    case "ASSIGNING_RIDER":
      return { label: t("status.cook.riderAssigned"), pathSuffix: "rider-assigned" };
    case "DISPATCHED":
    case "DELAYED":
      return { label: t("status.cook.markDelivered"), pathSuffix: "delivered" };
    default:
      return null;
  }
}
