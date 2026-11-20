import { cookProfiles, orders, type Db } from "@localmeals/db";
import { getLogisticsProvider, isMockLogistics } from "@localmeals/adapters";
import {
  LogEvent,
  bindTrace,
  createServiceLogger,
  orderTriageFields,
} from "@localmeals/observability";
import { assertFeatureEnabled } from "./featureFlags.js";
import { transitionOrder } from "./orders.js";

const logisticsLog = createServiceLogger("localmeals-api");

function kitchenPickupLine(cook: {
  kitchenName: string;
  pinCode: string;
  pickupLandmark?: string | null;
}) {
  return [cook.kitchenName, cook.pickupLandmark, `PIN ${cook.pinCode}`]
    .filter(Boolean)
    .join(", ");
}

/**
 * True when this cook should use partner logistics on dispatch
 * (platform flag on + cook.deliveryType PARTNER).
 */
export async function cookUsesPartnerDelivery(db: Db, cookId: string): Promise<boolean> {
  try {
    await assertFeatureEnabled(db, "partner_delivery_enabled");
  } catch {
    return false;
  }
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, cookId),
  });
  return cook?.deliveryType === "PARTNER";
}

/**
 * PACKED → create partner shipment → ASSIGNING_RIDER.
 * Mock provider auto-advances to DISPATCHED (rider assigned).
 */
export async function dispatchViaPartner(
  db: Db,
  order: typeof orders.$inferSelect,
  cook: typeof cookProfiles.$inferSelect,
) {
  await assertFeatureEnabled(
    db,
    "partner_delivery_enabled",
    "Partner delivery is turned off by admin",
  );
  if (order.fulfillmentMode === "PICKUP") {
    throw new Error("Pickup orders do not use partner delivery");
  }

  const logistics = getLogisticsProvider();
  const traceId = order.traceId?.trim() || undefined;
  if (traceId) {
    bindTrace({
      traceId,
      publicId: order.publicId,
      customerMobile: order.customerMobile,
      cookSlug: cook.slugHandle,
      cookId: cook.id,
      orderId: order.id,
      status: order.status,
      mealType: order.mealType,
      serviceDate: order.serviceDate,
    });
  }
  logisticsLog.info(
    {
      event: LogEvent.THIRD_PARTY_REQUEST,
      provider: logistics.name,
      action: "createShipment",
      ...orderTriageFields({
        traceId,
        publicId: order.publicId,
        orderId: order.id,
        customerMobile: order.customerMobile,
        cookSlug: cook.slugHandle,
        cookId: cook.id,
        status: order.status,
        mealType: order.mealType,
        serviceDate: order.serviceDate,
        itemName: order.itemName,
        qty: order.qty,
      }),
    },
    "logistics createShipment",
  );
  const shipment = await logistics.createShipment({
    orderPublicId: order.publicId,
    pickupAddress: kitchenPickupLine(cook),
    dropAddress: order.deliveryTargetAddress,
    customerMobile: order.customerMobile,
    cookMobile: cook.mobileNumber,
    notes: `${order.qty}× ${order.itemName}`,
    traceId,
  });

  // Stay on ASSIGNING_RIDER so cook/customer can see “Finding rider”.
  // Mock / webhook / cook “Rider assigned” advances to DISPATCHED.
  const trackingUrl =
    shipment.trackingUrl?.trim() ||
    partnerTrackingUrl(shipment.partnerShipmentId);

  const updated = await transitionOrder(db, order.id, "ASSIGNING_RIDER", {
    logisticsMode: "PARTNER",
    partnerShipmentId: shipment.partnerShipmentId,
    partnerTrackingUrl: trackingUrl,
  });

  if (isMockLogistics() && logistics.name === "mock") {
    const mock = logistics as {
      setStatus?: (id: string, s: "CREATED") => void;
    };
    mock.setStatus?.(shipment.partnerShipmentId, "CREATED");
  }

  return {
    order: updated,
    partnerShipmentId: shipment.partnerShipmentId,
    trackingUrl,
    status: updated.status,
  };
}

/** Tracking link for UI (stored URL preferred, else mock placeholder). */
export function partnerTrackingUrl(
  partnerShipmentId: string | null | undefined,
  storedUrl?: string | null,
): string | null {
  if (storedUrl?.trim()) return storedUrl.trim();
  if (!partnerShipmentId) return null;
  return `https://localmeals.local/track/${partnerShipmentId}`;
}

/** Cook desk / mock: rider found → on the way. */
export async function confirmPartnerRiderAssigned(
  db: Db,
  publicId: string,
  opts: { cookId?: string } = {},
) {
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!order) throw new Error("Order not found");
  if (opts.cookId && order.cookId !== opts.cookId) {
    throw new Error("That order is not for your kitchen");
  }
  if (order.status !== "ASSIGNING_RIDER") {
    throw new Error("Order is not waiting for a rider");
  }
  if (!order.partnerShipmentId || order.logisticsMode !== "PARTNER") {
    throw new Error("Order is not on partner delivery");
  }
  return applyPartnerShipmentUpdate(db, {
    partnerShipmentId: order.partnerShipmentId,
    status: "ASSIGNED",
  });
}

/** Apply partner webhook / poll result onto an order. */
export async function applyPartnerShipmentUpdate(
  db: Db,
  input: {
    partnerShipmentId: string;
    status: "CREATED" | "ASSIGNED" | "PICKED_UP" | "DELIVERED" | "FAILED";
    trackingUrl?: string | null;
  },
) {
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.partnerShipmentId, input.partnerShipmentId),
  });
  if (!order) throw new Error("Order not found for partner shipment");

  const trackingPatch =
    input.trackingUrl?.trim()
      ? { partnerTrackingUrl: input.trackingUrl.trim() }
      : {};

  if (input.status === "FAILED") {
    if (order.status === "ASSIGNING_RIDER" || order.status === "DISPATCHED") {
      return transitionOrder(db, order.id, "LOGISTICS_EXCEPTION", trackingPatch);
    }
    return order;
  }

  if (
    (input.status === "ASSIGNED" || input.status === "PICKED_UP") &&
    order.status === "ASSIGNING_RIDER"
  ) {
    return transitionOrder(db, order.id, "DISPATCHED", trackingPatch);
  }

  if (input.status === "DELIVERED" && order.status !== "DELIVERED") {
    if (order.status === "ASSIGNING_RIDER") {
      await transitionOrder(db, order.id, "DISPATCHED", trackingPatch);
    }
    const current = await db.query.orders.findFirst({
      where: (t, { eq: e }) => e(t.id, order.id),
    });
    if (current && (current.status === "DISPATCHED" || current.status === "DELAYED")) {
      return transitionOrder(db, order.id, "DELIVERED", trackingPatch);
    }
  }

  return order;
}
