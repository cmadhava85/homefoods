import { describe, expect, it } from "vitest";
import {
  cookNextAction,
  customerStatusBlurb,
  customerStatusHeadline,
  customerStatusLabel,
  customerStatusLabelKey,
  progressIndex,
  progressSteps,
  statusTone,
} from "./orderStatus";

const t = (key: string) => `T:${key}`;

describe("customerStatusLabelKey", () => {
  it("maps payment and pickup variants", () => {
    expect(customerStatusLabelKey("PENDING_APPROVAL")).toBe("status.label.waitingCook");
    expect(customerStatusLabelKey("AWAITING_PAYMENT")).toBe("status.label.payNow");
    expect(
      customerStatusLabelKey("AWAITING_PAYMENT", { childPays: true, roleOnOrder: "PAYER" }),
    ).toBe("status.label.familyYourTurn");
    expect(customerStatusLabelKey("AWAITING_PAYMENT", { childPays: true })).toBe(
      "status.label.waitingFamily",
    );
    expect(customerStatusLabelKey("CONFIRMING_PAYMENT")).toBe("status.label.confirming");
    expect(customerStatusLabelKey("PAID")).toBe("status.label.kitchenQueue");
    expect(customerStatusLabelKey("CANCEL_REQUESTED")).toBe("status.label.cancelRequested");
    expect(customerStatusLabelKey("COOKING")).toBe("status.label.cooking");
    expect(customerStatusLabelKey("PACKED", { fulfillmentMode: "PICKUP" })).toBe(
      "status.label.readyPickup",
    );
    expect(customerStatusLabelKey("PACKED")).toBe("status.label.packed");
    expect(customerStatusLabelKey("DISPATCHED")).toBe("status.label.onTheWay");
    expect(customerStatusLabelKey("DELAYED")).toBe("status.label.delayed");
    expect(customerStatusLabelKey("DELIVERED", { fulfillmentMode: "PICKUP" })).toBe(
      "status.label.pickedUp",
    );
    expect(customerStatusLabelKey("DELIVERED")).toBe("status.label.delivered");
    expect(customerStatusLabelKey("CANCELLED")).toBe("status.label.cancelled");
    expect(customerStatusLabelKey("FAILED")).toBe("status.label.payFailed");
    expect(customerStatusLabelKey("REFUNDED")).toBe("status.label.refunded");
    expect(customerStatusLabelKey("RETURNED_TO_KITCHEN")).toBe("status.label.returned");
    expect(customerStatusLabelKey("LOGISTICS_EXCEPTION")).toBe("status.label.deliveryIssue");
    expect(customerStatusLabelKey("WEIRD")).toBe("status.head.confirmed");
  });
});

describe("customerStatusLabel", () => {
  it("returns raw status for unknown codes", () => {
    expect(customerStatusLabel(t as never, "CUSTOM_STATE")).toBe("CUSTOM_STATE");
  });

  it("translates known codes", () => {
    expect(customerStatusLabel(t as never, "PAID")).toBe("T:status.label.kitchenQueue");
  });
});

describe("customerStatusHeadline / blurb", () => {
  it("covers family pay and pickup paths", () => {
    expect(customerStatusHeadline(t as never, "PENDING_APPROVAL")).toContain("lateSent");
    expect(
      customerStatusHeadline(t as never, "AWAITING_PAYMENT", {
        childPays: true,
        roleOnOrder: "PAYER",
      }),
    ).toContain("yourTurn");
    expect(customerStatusHeadline(t as never, "AWAITING_PAYMENT", { childPays: true })).toContain(
      "waitingFamily",
    );
    expect(customerStatusHeadline(t as never, "AWAITING_PAYMENT")).toContain("completePay");
    expect(customerStatusHeadline(t as never, "COOKING")).toContain("cooking");
    expect(customerStatusHeadline(t as never, "PACKED", { fulfillmentMode: "PICKUP" })).toContain(
      "readyPickup",
    );
    expect(customerStatusHeadline(t as never, "PACKED")).toContain("packedReady");
    expect(customerStatusHeadline(t as never, "DISPATCHED")).toContain("onTheWay");
    expect(customerStatusHeadline(t as never, "DELIVERED", { fulfillmentMode: "PICKUP" })).toContain(
      "pickedUp",
    );
    expect(customerStatusHeadline(t as never, "DELIVERED")).toContain("delivered");
    expect(customerStatusHeadline(t as never, "CANCEL_REQUESTED")).toContain("cancelRequested");
    expect(customerStatusHeadline(t as never, "CANCELLED")).toContain("cancelled");
    expect(customerStatusHeadline(t as never, "FAILED")).toContain("payFailed");
    expect(customerStatusHeadline(t as never, "REFUNDED")).toContain("refunded");
    expect(customerStatusHeadline(t as never, "PAID")).toContain("confirmed");

    expect(customerStatusBlurb(t as never, "PENDING_APPROVAL")).toContain("late");
    expect(
      customerStatusBlurb(t as never, "AWAITING_PAYMENT", {
        childPays: true,
        roleOnOrder: "PAYER",
      }),
    ).toContain("familyPayer");
    expect(customerStatusBlurb(t as never, "AWAITING_PAYMENT", { childPays: true })).toContain(
      "familyWait",
    );
    expect(customerStatusBlurb(t as never, "AWAITING_PAYMENT")).toContain("payUpi");
    expect(customerStatusBlurb(t as never, "PAID", { fulfillmentMode: "PICKUP" })).toContain(
      "paidPickup",
    );
    expect(customerStatusBlurb(t as never, "PAID")).toContain("paidQueue");
    expect(customerStatusBlurb(t as never, "COOKING")).toContain("cooking");
    expect(customerStatusBlurb(t as never, "PACKED", { fulfillmentMode: "PICKUP" })).toContain(
      "packedPickup",
    );
    expect(customerStatusBlurb(t as never, "PACKED")).toContain("packedDelivery");
    expect(customerStatusBlurb(t as never, "DISPATCHED")).toContain("onWay");
    expect(customerStatusBlurb(t as never, "DELIVERED", { fulfillmentMode: "PICKUP" })).toContain(
      "collected",
    );
    expect(customerStatusBlurb(t as never, "DELIVERED")).toContain("enjoy");
    expect(customerStatusBlurb(t as never, "CANCEL_REQUESTED")).toContain("cancelRequested");
    expect(customerStatusBlurb(t as never, "CANCELLED")).toContain("cancelled");
    expect(customerStatusBlurb(t as never, "FAILED")).toContain("failed");
    expect(customerStatusBlurb(t as never, "REFUNDED")).toContain("refunded");
    expect(customerStatusBlurb(t as never, "PAID")).toContain("paidQueue");
  });
});

describe("statusTone", () => {
  it("classifies tones", () => {
    expect(statusTone("AWAITING_PAYMENT")).toBe("warn");
    expect(statusTone("CONFIRMING_PAYMENT")).toBe("warn");
    expect(statusTone("PENDING_APPROVAL")).toBe("warn");
    expect(statusTone("CANCEL_REQUESTED")).toBe("warn");
    expect(statusTone("PAID")).toBe("progress");
    expect(statusTone("COOKING")).toBe("progress");
    expect(statusTone("PACKED")).toBe("progress");
    expect(statusTone("DISPATCHED")).toBe("go");
    expect(statusTone("DELAYED")).toBe("go");
    expect(statusTone("DELIVERED")).toBe("done");
    expect(statusTone("CANCELLED")).toBe("bad");
    expect(statusTone("FAILED")).toBe("bad");
    expect(statusTone("REFUNDED")).toBe("bad");
    expect(statusTone("UNKNOWN")).toBe("neutral");
  });
});

describe("progressIndex / progressSteps", () => {
  it("tracks delivery and pickup ladders", () => {
    expect(progressIndex("PAID")).toBe(0);
    expect(progressIndex("COOKING")).toBe(1);
    expect(progressIndex("PACKED")).toBe(2);
    expect(progressIndex("DISPATCHED")).toBe(3);
    expect(progressIndex("DELIVERED")).toBe(4);
    expect(progressIndex("DISPATCHED", "PICKUP")).toBe(-1);
    expect(progressIndex("PACKED", "PICKUP")).toBe(2);
    expect(progressIndex("DELIVERED", "PICKUP")).toBe(3);
    expect(progressIndex("DELAYED")).toBe(3);
    expect(progressIndex("DELAYED", "PICKUP")).toBe(2);

    const steps = progressSteps(t as never, "COOKING");
    expect(steps).toHaveLength(5);
    expect(steps[1].state).toBe("current");
    expect(steps[0].state).toBe("done");
    expect(steps[2].state).toBe("todo");

    const pickup = progressSteps(t as never, "PACKED", "PICKUP");
    expect(pickup).toHaveLength(4);
    expect(pickup[2].state).toBe("current");
    expect(pickup[2].label).toContain("readyPickup");

    const idle = progressSteps(t as never, "AWAITING_PAYMENT");
    expect(idle.every((s) => s.state === "idle")).toBe(true);
  });
});

describe("cookNextAction", () => {
  it("returns desk transitions", () => {
    expect(cookNextAction(t as never, "PAID")).toEqual({
      label: "T:status.cook.startCooking",
      pathSuffix: "cooking",
    });
    expect(cookNextAction(t as never, "COOKING")).toEqual({
      label: "T:status.cook.markPacked",
      pathSuffix: "pack",
    });
    expect(cookNextAction(t as never, "PACKED")).toEqual({
      label: "T:status.cook.dispatch",
      pathSuffix: "dispatch",
    });
    expect(cookNextAction(t as never, "PACKED", "PICKUP")).toEqual({
      label: "T:status.cook.markPickedUp",
      pathSuffix: "delivered",
    });
    expect(cookNextAction(t as never, "DISPATCHED")).toEqual({
      label: "T:status.cook.markDelivered",
      pathSuffix: "delivered",
    });
    expect(cookNextAction(t as never, "DELAYED")).toEqual({
      label: "T:status.cook.markDelivered",
      pathSuffix: "delivered",
    });
    expect(cookNextAction(t as never, "DELIVERED")).toBeNull();
    expect(cookNextAction(t as never, "CANCEL_REQUESTED")).toBeNull();
    expect(cookNextAction(t as never, "PAID")?.label).not.toBe("");
  });
});
