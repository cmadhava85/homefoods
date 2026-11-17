import { cookProfiles, orders, type Db } from "@localmeals/db";
import { getLogisticsProvider, isMockLogistics } from "@localmeals/adapters";
import { assertFeatureEnabled } from "./featureFlags.js";
import { transitionOrder } from "./orders.js";

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
  const shipment = await logistics.createShipment({
    orderPublicId: order.publicId,
    pickupAddress: kitchenPickupLine(cook),
    dropAddress: order.deliveryTargetAddress,
    customerMobile: order.customerMobile,
    cookMobile: cook.mobileNumber,
    notes: `${order.qty}× ${order.itemName}`,
  });

  let updated = await transitionOrder(db, order.id, "ASSIGNING_RIDER", {
    logisticsMode: "PARTNER",
    partnerShipmentId: shipment.partnerShipmentId,
  });

  // Mock (and some vendors) assign immediately — move to on-the-way.
  if (shipment.status === "ASSIGNED" || isMockLogistics()) {
    if (isMockLogistics() && logistics.name === "mock") {
      const mock = logistics as {
        setStatus?: (id: string, s: "ASSIGNED") => void;
      };
      mock.setStatus?.(shipment.partnerShipmentId, "ASSIGNED");
    }
    updated = await transitionOrder(db, order.id, "DISPATCHED");
  }

  return {
    order: updated,
    partnerShipmentId: shipment.partnerShipmentId,
    trackingUrl: shipment.trackingUrl ?? null,
    status: updated.status,
  };
}

/** Apply partner webhook / poll result onto an order. */
export async function applyPartnerShipmentUpdate(
  db: Db,
  input: {
    partnerShipmentId: string;
    status: "CREATED" | "ASSIGNED" | "PICKED_UP" | "DELIVERED" | "FAILED";
  },
) {
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.partnerShipmentId, input.partnerShipmentId),
  });
  if (!order) throw new Error("Order not found for partner shipment");

  if (input.status === "FAILED") {
    if (order.status === "ASSIGNING_RIDER" || order.status === "DISPATCHED") {
      return transitionOrder(db, order.id, "LOGISTICS_EXCEPTION");
    }
    return order;
  }

  if (
    (input.status === "ASSIGNED" || input.status === "PICKED_UP") &&
    order.status === "ASSIGNING_RIDER"
  ) {
    return transitionOrder(db, order.id, "DISPATCHED");
  }

  if (input.status === "DELIVERED" && order.status !== "DELIVERED") {
    if (order.status === "ASSIGNING_RIDER") {
      await transitionOrder(db, order.id, "DISPATCHED");
    }
    const current = await db.query.orders.findFirst({
      where: (t, { eq: e }) => e(t.id, order.id),
    });
    if (current && (current.status === "DISPATCHED" || current.status === "DELAYED")) {
      return transitionOrder(db, order.id, "DELIVERED");
    }
  }

  return order;
}
