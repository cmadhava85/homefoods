import { and, eq } from "drizzle-orm";
import {
  cookMealSettings,
  cookMenuTemplates,
  cookProfiles,
  cookSavedPlates,
  cutoffLocks,
  dailyMenus,
  orders,
  outbox,
  platformEventLedger,
  type CookMenuTemplateItem,
  type Db,
} from "@localmeals/db";
import { LogEvent, createServiceLogger } from "@localmeals/observability";
import {
  assertCanAcceptPaidOrders,
  assertFulfillmentOffersValid,
  assertValidCutoff,
  assertValidDeliveryWindow,
  cookFulfillmentOffersFromRow,
  defaultMealSchedule,
  describeWeekDiscount,
  formatCutoffLabel,
  formatDeliveryWindowLabel,
  formatOrderPaidFeedPreview,
  isAtOrPastCutoff,
  isIntakePausedForDate,
  groupCookStops,
  mealLabel,
  MEAL_PERIODS,
  normalizeWeekDiscountRule,
  serviceDateISO,
  type DeliveryWindow,
  type MealPeriod,
} from "@localmeals/domain";
import { buildMultiStopMapsUrl, getWhatsAppProvider } from "@localmeals/adapters";
import { enqueueOutbox } from "./outboxEnqueue.js";
import {
  loadMealSettingsRows,
  scheduleForCook,
  transitionOrder,
} from "./orders.js";

const log = createServiceLogger("localmeals-api");

export async function ensureCookMealSettings(db: Db, cookId: string) {
  const existing = await loadMealSettingsRows(db, cookId);
  const have = new Set(existing.map((r) => r.mealType));
  for (const meal of MEAL_PERIODS) {
    if (have.has(meal)) continue;
    const def = defaultMealSchedule(meal);
    await db.insert(cookMealSettings).values({
      cookId,
      mealType: meal,
      enabled: def.enabled,
      cutoffHour: def.cutoff.hour,
      cutoffMinute: def.cutoff.minute,
      deliveryStartHour: def.deliveryWindow.startHour,
      deliveryStartMinute: def.deliveryWindow.startMinute,
      deliveryEndHour: def.deliveryWindow.endHour,
      deliveryEndMinute: def.deliveryWindow.endMinute,
    });
  }
}

export async function getCookMealSettings(db: Db, cookSlug: string) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  await ensureCookMealSettings(db, cook.id);
  const rows = await loadMealSettingsRows(db, cook.id);
  const weekRule = normalizeWeekDiscountRule({
    percent: cook.weekDiscountPercent,
    minDays: cook.weekDiscountMinDays,
  });
  const { getFeatureFlags } = await import("./featureFlags.js");
  const { isFeatureEnabled } = await import("@localmeals/domain");
  const flags = await getFeatureFlags(db);
  return {
    cook: { id: cook.id, kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
    weekDiscount: {
      percent: weekRule.percent,
      minDays: weekRule.minDays,
      label: describeWeekDiscount(weekRule),
      platformEnabled: isFeatureEnabled(flags, "week_discount_enabled"),
    },
    pickup: {
      enabled: Boolean(cook.pickupEnabled),
      landmark: cook.pickupLandmark?.trim() || null,
      platformEnabled: isFeatureEnabled(flags, "pickup_enabled"),
    },
    intake: {
      paused: isIntakePausedForDate(cook.intakePausedDate, serviceDateISO()),
      pausedDate: cook.intakePausedDate ?? null,
      serviceDate: serviceDateISO(),
    },
    fulfillmentOffers: cookFulfillmentOffersFromRow(cook),
    delivery: {
      type: (cook.deliveryType === "PARTNER" ? "PARTNER" : "SELF") as "SELF" | "PARTNER",
      platformPartnerEnabled: isFeatureEnabled(flags, "partner_delivery_enabled"),
      /** Active partner path on dispatch when flag ON and type PARTNER. */
      partnerActive:
        isFeatureEnabled(flags, "partner_delivery_enabled") && cook.deliveryType === "PARTNER",
    },
    meals: MEAL_PERIODS.map((meal) => {
      const row = rows.find((r) => r.mealType === meal) ?? null;
      const def = defaultMealSchedule(meal);
      const enabled = meal === "LUNCH" ? true : (row?.enabled ?? def.enabled);
      const cutoff = {
        hour: row?.cutoffHour ?? def.cutoff.hour,
        minute: row?.cutoffMinute ?? def.cutoff.minute,
      };
      const deliveryWindow = {
        startHour: row?.deliveryStartHour ?? def.deliveryWindow.startHour,
        startMinute: row?.deliveryStartMinute ?? def.deliveryWindow.startMinute,
        endHour: row?.deliveryEndHour ?? def.deliveryWindow.endHour,
        endMinute: row?.deliveryEndMinute ?? def.deliveryWindow.endMinute,
      };
      return {
        mealType: meal,
        mealLabel: mealLabel(meal),
        enabled,
        cutoffHour: cutoff.hour,
        cutoffMinute: cutoff.minute,
        cutoff: formatCutoffLabel(cutoff),
        deliveryWindow,
        deliveryWindowLabel: formatDeliveryWindowLabel(deliveryWindow),
      };
    }),
  };
}

export async function updateCookMealSettings(
  db: Db,
  cookSlug: string,
  mealType: MealPeriod,
  patch: {
    enabled?: boolean;
    cutoffHour?: number;
    cutoffMinute?: number;
    deliveryWindow?: DeliveryWindow;
  },
) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  await ensureCookMealSettings(db, cook.id);

  const current = (await loadMealSettingsRows(db, cook.id)).find((r) => r.mealType === mealType);
  const def = defaultMealSchedule(mealType);
  const enabled = mealType === "LUNCH" ? true : (patch.enabled ?? current?.enabled ?? def.enabled);
  const cutoffHour = patch.cutoffHour ?? current?.cutoffHour ?? def.cutoff.hour;
  const cutoffMinute = patch.cutoffMinute ?? current?.cutoffMinute ?? def.cutoff.minute;
  assertValidCutoff(cutoffHour, cutoffMinute);
  const deliveryWindow = patch.deliveryWindow ?? {
    startHour: current?.deliveryStartHour ?? def.deliveryWindow.startHour,
    startMinute: current?.deliveryStartMinute ?? def.deliveryWindow.startMinute,
    endHour: current?.deliveryEndHour ?? def.deliveryWindow.endHour,
    endMinute: current?.deliveryEndMinute ?? def.deliveryWindow.endMinute,
  };
  assertValidDeliveryWindow(deliveryWindow);

  await db
    .update(cookMealSettings)
    .set({
      enabled,
      cutoffHour,
      cutoffMinute,
      deliveryStartHour: deliveryWindow.startHour,
      deliveryStartMinute: deliveryWindow.startMinute,
      deliveryEndHour: deliveryWindow.endHour,
      deliveryEndMinute: deliveryWindow.endMinute,
      updatedAt: new Date(),
    })
    .where(
      and(eq(cookMealSettings.cookId, cook.id), eq(cookMealSettings.mealType, mealType)),
    );

  // Dual-write lunch onto legacy cook_profiles columns
  if (mealType === "LUNCH") {
    await db
      .update(cookProfiles)
      .set({
        lunchCutoffHour: cutoffHour,
        lunchCutoffMinute: cutoffMinute,
        deliveryWindowStartHour: deliveryWindow.startHour,
        deliveryWindowStartMinute: deliveryWindow.startMinute,
        deliveryWindowEndHour: deliveryWindow.endHour,
        deliveryWindowEndMinute: deliveryWindow.endMinute,
      })
      .where(eq(cookProfiles.id, cook.id));
  }

  return getCookMealSettings(db, cookSlug);
}

export async function setCookWeekDiscount(
  db: Db,
  cookSlug: string,
  input: { percent: number; minDays: number },
) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  const rule = normalizeWeekDiscountRule(input);
  await db
    .update(cookProfiles)
    .set({
      weekDiscountPercent: rule.percent,
      weekDiscountMinDays: rule.minDays,
    })
    .where(eq(cookProfiles.id, cook.id));
  return {
    weekDiscountPercent: rule.percent,
    weekDiscountMinDays: rule.minDays,
    label: describeWeekDiscount(rule),
  };
}

/** Cook opts into pickup when platform `pickup_enabled` is on; landmark required to go live. */
export async function setCookPickupSettings(
  db: Db,
  cookSlug: string,
  input: { pickupEnabled?: boolean; pickupLandmark?: string | null },
) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");

  const landmark =
    input.pickupLandmark !== undefined
      ? input.pickupLandmark?.trim() || null
      : cook.pickupLandmark?.trim() || null;
  const enabled =
    input.pickupEnabled !== undefined ? Boolean(input.pickupEnabled) : Boolean(cook.pickupEnabled);

  if (enabled && !landmark) {
    throw new Error("Set a pickup landmark before enabling kitchen pickup");
  }

  const offers = cookFulfillmentOffersFromRow({
    ...cook,
    pickupEnabled: enabled,
  });
  assertFulfillmentOffersValid(offers);

  await db
    .update(cookProfiles)
    .set({
      pickupEnabled: enabled,
      pickupLandmark: landmark,
    })
    .where(eq(cookProfiles.id, cook.id));

  const { getFeatureFlags } = await import("./featureFlags.js");
  const { isFeatureEnabled } = await import("@localmeals/domain");
  const flags = await getFeatureFlags(db);
  const platformEnabled = isFeatureEnabled(flags, "pickup_enabled");
  return {
    pickupEnabled: enabled,
    pickupLandmark: landmark,
    platformEnabled,
    availableToCustomers: Boolean(platformEnabled && enabled && landmark),
    fulfillmentOffers: offers,
  };
}

/** One-tap pause / resume intake for today's service date only. */
export async function setCookIntakePause(
  db: Db,
  cookSlug: string,
  input: { paused: boolean },
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const today = serviceDateISO();
  const intakePausedDate = input.paused ? today : null;
  await db
    .update(cookProfiles)
    .set({ intakePausedDate })
    .where(eq(cookProfiles.id, cook.id));
  return {
    paused: Boolean(intakePausedDate),
    pausedDate: intakePausedDate,
    serviceDate: today,
  };
}

/** Town fulfillment toggles: cook delivery · pickup · customer arranges. */
export async function setCookFulfillmentOffers(
  db: Db,
  cookSlug: string,
  input: {
    cookDelivery?: boolean;
    customerArrange?: boolean;
    pickupEnabled?: boolean;
    pickupLandmark?: string | null;
  },
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const landmark =
    input.pickupLandmark !== undefined
      ? input.pickupLandmark?.trim() || null
      : cook.pickupLandmark?.trim() || null;
  const pickupEnabled =
    input.pickupEnabled !== undefined ? Boolean(input.pickupEnabled) : Boolean(cook.pickupEnabled);
  if (pickupEnabled && !landmark) {
    throw new Error("Set a pickup landmark before enabling kitchen pickup");
  }
  const offerCookDelivery =
    input.cookDelivery !== undefined ? Boolean(input.cookDelivery) : cook.offerCookDelivery !== false;
  const offerCustomerArrange =
    input.customerArrange !== undefined
      ? Boolean(input.customerArrange)
      : Boolean(cook.offerCustomerArrange);

  const offers = {
    cookDelivery: offerCookDelivery,
    pickup: pickupEnabled,
    customerArrange: offerCustomerArrange,
  };
  assertFulfillmentOffersValid(offers);

  await db
    .update(cookProfiles)
    .set({
      offerCookDelivery,
      offerCustomerArrange,
      pickupEnabled,
      pickupLandmark: landmark,
    })
    .where(eq(cookProfiles.id, cook.id));

  const { getFeatureFlags } = await import("./featureFlags.js");
  const { isFeatureEnabled } = await import("@localmeals/domain");
  const flags = await getFeatureFlags(db);
  return {
    fulfillmentOffers: offers,
    pickupEnabled,
    pickupLandmark: landmark,
    pickupPlatformEnabled: isFeatureEnabled(flags, "pickup_enabled"),
  };
}

export async function runMealCutoff(
  db: Db,
  mealType: MealPeriod,
  opts: { cookId?: string; force?: boolean } = {},
) {
  const serviceDate = serviceDateISO();
  const now = new Date();
  const cooks = opts.cookId
    ? await db.query.cookProfiles.findMany({
        where: (t, { eq: e }) => e(t.id, opts.cookId!),
      })
    : await db.query.cookProfiles.findMany({
        where: (t, { eq: e }) => e(t.onboardingStatus, "LIVE"),
      });

  const results = [];
  for (const cook of cooks) {
    const schedule = await scheduleForCook(db, cook, mealType);
    if (!schedule.enabled) {
      results.push({
        cookId: cook.id,
        slugHandle: cook.slugHandle,
        skipped: true,
        reason: `${mealLabel(mealType)} disabled`,
      });
      continue;
    }
    if (!opts.force && !isAtOrPastCutoff(mealType, now, serviceDate, schedule.cutoff)) {
      results.push({
        cookId: cook.id,
        slugHandle: cook.slugHandle,
        skipped: true,
        reason: `before cook cut-off ${formatCutoffLabel(schedule.cutoff)}`,
      });
      continue;
    }

    const paidOrders = await db.query.orders.findMany({
      where: (t, { eq: e, and: a, inArray: ia }) =>
        a(
          e(t.cookId, cook.id),
          e(t.serviceDate, serviceDate),
          e(t.mealType, mealType),
          ia(t.status, ["PAID", "COOKING"]),
        ),
    });

    for (const o of paidOrders) {
      if (o.status === "PAID") {
        await transitionOrder(db, o.id, "COOKING");
      }
    }

    // Club same customer + address into one stop (extra same-day orders stay separate rows).
    const stopGroups = groupCookStops(paidOrders);
    const addresses = stopGroups
      .filter((g) => g.fulfillmentMode !== "PICKUP" && g.deliveryTargetAddress)
      .map((g) => ({
        label: g.orders.map((o) => o.publicId).join("+"),
        address: g.deliveryTargetAddress,
      }));
    const routeMapsUrl = buildMultiStopMapsUrl(addresses);
    const headcount = paidOrders.reduce((n, o) => n + o.qty, 0);
    const lessSpicy = paidOrders
      .filter((o) => o.spice === "LESS")
      .reduce((n, o) => n + o.qty, 0);

    const existingLock = await db.query.cutoffLocks.findFirst({
      where: (t, { eq: e, and: a }) =>
        a(e(t.cookId, cook.id), e(t.serviceDate, serviceDate), e(t.mealType, mealType)),
    });
    if (existingLock) {
      await db
        .update(cutoffLocks)
        .set({ headcount, routeMapsUrl, lockedAt: new Date() })
        .where(eq(cutoffLocks.id, existingLock.id));
    } else {
      await db.insert(cutoffLocks).values({
        cookId: cook.id,
        mealType,
        serviceDate,
        headcount,
        routeMapsUrl,
      });
    }

    if (routeMapsUrl) {
      for (const o of paidOrders) {
        await db
          .update(orders)
          .set({ routeMapsUrl, updatedAt: new Date() })
          .where(eq(orders.id, o.id));
      }
    }

    const wa = getWhatsAppProvider();
    const stopLines = stopGroups.map((g, i) => {
      const lines = g.orders.map(
        (o) => `   · ${o.publicId} · ${o.qty}× ${o.itemName}${o.spice === "LESS" ? " · less spicy" : ""}`,
      );
      const modeTag = g.fulfillmentMode === "PICKUP" ? " · pickup" : "";
      const addr =
        g.fulfillmentMode === "PICKUP"
          ? "Pickup"
          : g.deliveryTargetAddress || "Address missing";
      const head =
        g.orders.length > 1
          ? `${i + 1}. Stop · ${g.totalQty} plates · ${g.orders.length} orders${modeTag}`
          : `${i + 1}. ${g.orders[0].publicId} · ${g.orders[0].qty}× ${g.orders[0].itemName}${modeTag}`;
      return [
        head,
        `   📍 ${addr}`,
        g.orders.length > 1 ? lines.join("\n") : null,
      ]
        .filter(Boolean)
        .join("\n");
    });
    await wa.send({
      to: cook.mobileNumber,
      body: [
        `🔒 ${mealLabel(mealType)} locked · ${headcount} plates · ${serviceDate}`,
        lessSpicy ? `Less spicy: ${lessSpicy}` : null,
        "",
        ...stopLines,
        routeMapsUrl ? `\nRoute: ${routeMapsUrl}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      buttons: routeMapsUrl ? ["Open route map", "Mark packed"] : ["Mark packed"],
    });

    await enqueueOutbox(db, "CutoffReached", {
      cookId: cook.id,
      cookMobile: cook.mobileNumber,
      serviceDate,
      mealType,
      headcount,
      routeMapsUrl,
    });
    log.info(
      {
        event: LogEvent.CUTOFF_REACHED,
        cookId: cook.id,
        serviceDate,
        mealType,
        headcount,
      },
      "cutoff reached",
    );

    results.push({
      cookId: cook.id,
      slugHandle: cook.slugHandle,
      mealType,
      headcount,
      routeMapsUrl,
      cutoff: formatCutoffLabel(schedule.cutoff),
      lunchCutoff: formatCutoffLabel(schedule.cutoff),
    });
  }

  // After cut-off batch: also drop unpaid rows for earlier service dates.
  const { expireUnpaidOrdersPastServiceDate } = await import("./orders.js");
  const expired = await expireUnpaidOrdersPastServiceDate(db);

  return { serviceDate, mealType, results, unpaidExpired: expired };
}

export async function runLunchCutoff(
  db: Db,
  opts: { cookId?: string; force?: boolean } = {},
) {
  return runMealCutoff(db, "LUNCH", opts);
}

function foodLinePaise(o: {
  foodPaise: number;
  qty: number;
  foodDiscountPaise?: number | null;
}) {
  return Math.max(0, o.foodPaise * o.qty - (o.foodDiscountPaise ?? 0));
}

function payoutLabel(settlement: {
  status: string;
  netPaise: number;
  manualPaidAt: Date | null;
  manualUtr: string | null;
} | null) {
  if (!settlement) {
    return {
      status: "NONE" as const,
      label: "Payout after EOD · when plates are delivered",
      detail: null as string | null,
    };
  }
  if (settlement.manualPaidAt || settlement.status === "COMPLETED" || settlement.status === "TRANSFER_PROCESSED") {
    return {
      status: "PAID" as const,
      label: "Paid",
      detail: settlement.manualUtr
        ? `UTR ${settlement.manualUtr}`
        : `₹${(settlement.netPaise / 100).toFixed(0)} settled`,
    };
  }
  if (settlement.status === "AWAITING_MANUAL_PAY" || settlement.status === "PENDING_TRANSFER") {
    return {
      status: "PENDING" as const,
      label: "Awaiting payout",
      detail: `₹${(settlement.netPaise / 100).toFixed(0)} · Admin marks paid after EOD`,
    };
  }
  return {
    status: "OTHER" as const,
    label: settlement.status,
    detail: `₹${(settlement.netPaise / 100).toFixed(0)}`,
  };
}

export async function getManifest(
  db: Db,
  cookSlug: string,
  serviceDate = serviceDateISO(),
  mealType: MealPeriod = "LUNCH",
) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  await ensureCookMealSettings(db, cook.id);
  const schedule = await scheduleForCook(db, cook, mealType);
  const lock = await db.query.cutoffLocks.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.cookId, cook.id), e(t.serviceDate, serviceDate), e(t.mealType, mealType)),
  });
  const orderRows = await db.query.orders.findMany({
    where: (t, { eq: e, and: a, inArray: ia }) =>
      a(
        e(t.cookId, cook.id),
        e(t.serviceDate, serviceDate),
        e(t.mealType, mealType),
        ia(t.status, [
          "PAID",
          "CANCEL_REQUESTED",
          "COOKING",
          "PACKED",
          "ASSIGNING_RIDER",
          "DISPATCHED",
          "DELAYED",
          "DELIVERED",
          "LOGISTICS_EXCEPTION",
        ]),
      ),
  });

  // Day-wide paid queue (all meals) — what cooks care about for earnings / EOD.
  const dayOrders = await db.query.orders.findMany({
    where: (t, { eq: e, and: a, inArray: ia }) =>
      a(
        e(t.cookId, cook.id),
        e(t.serviceDate, serviceDate),
        ia(t.status, [
          "PAID",
          "CANCEL_REQUESTED",
          "COOKING",
          "PACKED",
          "ASSIGNING_RIDER",
          "DISPATCHED",
          "DELAYED",
          "DELIVERED",
          "LOGISTICS_EXCEPTION",
        ]),
      ),
  });
  const settlement = await db.query.settlements.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.cookId, cook.id), e(t.businessDate, serviceDate)),
  });

  const mealPlates = orderRows.reduce((n, o) => n + o.qty, 0);
  const mealFoodPaise = orderRows.reduce((n, o) => n + foodLinePaise(o), 0);
  const dayPlates = dayOrders.reduce((n, o) => n + o.qty, 0);
  const dayFoodPaise = dayOrders.reduce((n, o) => n + foodLinePaise(o), 0);
  const deliveredOrders = dayOrders.filter((o) => o.status === "DELIVERED" && !o.settlementHold);
  const deliveredFoodPaise = deliveredOrders.reduce((n, o) => n + foodLinePaise(o), 0);
  const heldPlates = dayOrders
    .filter((o) => o.settlementHold)
    .reduce((n, o) => n + o.qty, 0);
  const payout = payoutLabel(settlement ?? null);
  const { sumPendingClawbackPaise } = await import("./cookClawback.js");
  const pendingClawbackPaise = await sumPendingClawbackPaise(db, cook.id);

  const { getFeatureFlags } = await import("./featureFlags.js");
  const { isFeatureEnabled } = await import("@localmeals/domain");
  const { partnerTrackingUrl } = await import("./partnerLogistics.js");
  const flags = await getFeatureFlags(db);
  const partnerActive =
    isFeatureEnabled(flags, "partner_delivery_enabled") && cook.deliveryType === "PARTNER";

  return {
    cook: {
      id: cook.id,
      kitchenName: cook.kitchenName,
      slugHandle: cook.slugHandle,
      mobileNumber: cook.mobileNumber,
      deliveryType: cook.deliveryType === "PARTNER" ? "PARTNER" : "SELF",
    },
    delivery: {
      type: cook.deliveryType === "PARTNER" ? "PARTNER" : "SELF",
      platformPartnerEnabled: isFeatureEnabled(flags, "partner_delivery_enabled"),
      partnerActive,
    },
    mealType,
    mealLabel: mealLabel(mealType),
    mealEnabled: schedule.enabled,
    lock,
    orders: orderRows.map((o) => ({
      ...o,
      partnerTrackingUrl:
        o.logisticsMode === "PARTNER"
          ? partnerTrackingUrl(o.partnerShipmentId, o.partnerTrackingUrl)
          : null,
    })),
    lunchCutoff: formatCutoffLabel(schedule.cutoff),
    cutoff: formatCutoffLabel(schedule.cutoff),
    deliveryWindow: formatDeliveryWindowLabel(schedule.deliveryWindow),
    deliveryWindowParts: schedule.deliveryWindow,
    earnings: {
      serviceDate,
      /** You keep 100% of food; delivery + ₹7 stay with platform. */
      note: "You earn 100% of food. Delivery fee and ₹7 platform fee stay with LocalMeals.",
      meal: {
        mealType,
        plates: mealPlates,
        foodPaise: mealFoodPaise,
      },
      day: {
        plates: dayPlates,
        foodPaise: dayFoodPaise,
        deliveredPlates: deliveredOrders.reduce((n, o) => n + o.qty, 0),
        deliveredFoodPaise,
        heldPlates,
        pendingClawbackPaise,
        clawbackPaise: settlement?.clawbackPaise ?? 0,
      },
      payout: {
        ...payout,
        netPaise: settlement?.netPaise ?? null,
        orderCount: settlement?.orderCount ?? null,
        manualPaidAt: settlement?.manualPaidAt ?? null,
        manualUtr: settlement?.manualUtr ?? null,
        settlementStatus: settlement?.status ?? null,
        clawbackPaise: settlement?.clawbackPaise ?? 0,
      },
    },
    whatsapp: {
      cookMobile: cook.mobileNumber,
      note:
        "Paid orders and cut-off digests are sent to this WhatsApp number (mock logs locally).",
    },
  };
}

/** Recent cook-facing WhatsApp events (from outbox) for the desk feed. */
export async function getCookWhatsAppFeed(db: Db, cookSlug: string, limit = 20) {
  const cook = await requireCookBySlug(db, cookSlug);
  const rows = await db.query.outbox.findMany({
    orderBy: (t, { desc }) => [desc(t.id)],
    limit: 80,
  });
  const feed = rows
    .filter((r) => {
      const p = r.payload as Record<string, unknown>;
      return p.cookId === cook.id || p.cookMobile === cook.mobileNumber;
    })
    .slice(0, limit)
    .map((r) => {
      const p = r.payload as Record<string, unknown>;
      let preview = r.eventName;
      if (r.eventName === "OrderPaid") {
        preview = formatOrderPaidFeedPreview(p);
      } else if (r.eventName === "CutoffReached") {
        preview = `Manifest locked · ${p.headcount ?? "?"} plates${p.routeMapsUrl ? " · route ready" : ""}`;
      } else if (r.eventName === "SettlementBatchCompleted") {
        preview = `EOD settlement · net mentioned in WA to cook`;
      } else if (r.eventName === "LateOrderRequested") {
        preview = `Late request ${p.publicId ?? ""} · ${p.qty ?? 1}× ${p.itemName ?? ""} — accept on desk`;
      } else if (r.eventName === "LateOrderApproved") {
        preview = `Late accepted ${p.publicId ?? ""} · pay link sent`;
      } else if (r.eventName === "LateOrderDeclined") {
        preview = `Late declined ${p.publicId ?? ""}`;
      }
      return {
        id: r.id,
        eventName: r.eventName,
        preview: preview.trim(),
        to: cook.mobileNumber,
        processedAt: r.processedAt,
        createdAt: r.createdAt,
        payload: p,
      };
    });
  return { cookMobile: cook.mobileNumber, messages: feed };
}

async function notifyOrderStatus(
  db: Db,
  order: {
    id: number;
    publicId: string;
    customerMobile: string;
    itemName: string;
    qty: number;
    status: string;
    cookId: string;
    fulfillmentMode?: string | null;
  },
  toStatus: string,
) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, order.cookId),
  });
  const { getFeatureFlags } = await import("./featureFlags.js");
  const { isFeatureEnabled } = await import("@localmeals/domain");
  const flags = await getFeatureFlags(db);
  const leanPlatformOn = isFeatureEnabled(flags, "lean_wa_status_enabled");
  let leanWaOptIn = false;
  if (leanPlatformOn) {
    const row = await db.query.users.findFirst({
      where: (t, { eq: eqm }) => eqm(t.mobileNumber, order.customerMobile),
    });
    const consents = (row?.consents ?? {}) as Record<string, boolean>;
    leanWaOptIn = consents.leanWaStatus === true;
  }
  await enqueueOutbox(db, "OrderStatusChanged", {
      orderId: order.id,
      publicId: order.publicId,
      customerMobile: order.customerMobile,
      cookMobile: cook?.mobileNumber ?? null,
      kitchenName: cook?.kitchenName ?? null,
      itemName: order.itemName,
      qty: order.qty,
      fromStatus: order.status,
      toStatus,
      fulfillmentMode: order.fulfillmentMode ?? "DELIVERY",
      leanWaOptIn,
    });
}

/** Partner path: cook confirms rider found (mock or ops). */
export async function markPartnerRiderAssigned(db: Db, publicId: string, cookId: string) {
  const { confirmPartnerRiderAssigned } = await import("./partnerLogistics.js");
  const updated = await confirmPartnerRiderAssigned(db, publicId, { cookId });
  await notifyOrderStatus(db, updated, "DISPATCHED");
  return updated;
}

/** Advance one order along the kitchen path (cook desk / WhatsApp). */
export async function advanceOrderKitchenStatus(
  db: Db,
  publicId: string,
  to: "COOKING" | "PACKED" | "DISPATCHED" | "DELIVERED",
  opts: {
    cookId?: string;
    channel?: "WHATSAPP_BOT" | "WEB_STOREFRONT" | "SYSTEM_CRON" | "ADMIN";
  } = {},
) {
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!order) throw new Error("Order not found");
  if (opts.cookId && order.cookId !== opts.cookId) {
    throw new Error("That order is not for your kitchen");
  }
  const activityChannel = opts.channel ?? "WEB_STOREFRONT";

  if (
    to === "DISPATCHED" &&
    order.fulfillmentMode !== "PICKUP" &&
    order.fulfillmentMode !== "CUSTOMER_ARRANGE"
  ) {
    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.id, order.cookId),
    });
    if (!cook) throw new Error("Cook not found");
    const { cookUsesPartnerDelivery, dispatchViaPartner } = await import("./partnerLogistics.js");
    if (await cookUsesPartnerDelivery(db, cook.id)) {
      const res = await dispatchViaPartner(db, order, cook);
      await notifyOrderStatus(db, order, res.status);
      return res.order;
    }
  }

  const updated = await transitionOrder(
    db,
    order.id,
    to,
    {
      ...(to === "DISPATCHED" ? { logisticsMode: "SELF" as const } : {}),
    },
    { channel: activityChannel },
  );
  await notifyOrderStatus(db, order, to);
  return updated;
}

type OpsChannel = "WHATSAPP_BOT" | "WEB_STOREFRONT" | "SYSTEM_CRON" | "ADMIN";

export async function markPacked(
  db: Db,
  cookSlug: string,
  serviceDate = serviceDateISO(),
  mealType: MealPeriod = "LUNCH",
  opts: { channel?: OpsChannel } = {},
) {
  const activityChannel = opts.channel ?? "WEB_STOREFRONT";
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  const cooking = await db.query.orders.findMany({
    where: (t, { eq: e, and: a }) =>
      a(
        e(t.cookId, cook.id),
        e(t.serviceDate, serviceDate),
        e(t.mealType, mealType),
        e(t.status, "COOKING"),
      ),
  });
  for (const o of cooking) {
    await transitionOrder(db, o.id, "PACKED", undefined, { channel: activityChannel });
    await notifyOrderStatus(db, o, "PACKED");
  }
  return { packed: cooking.length, publicIds: cooking.map((o) => o.publicId) };
}

export async function markDispatched(
  db: Db,
  cookSlug: string,
  serviceDate = serviceDateISO(),
  mealType: MealPeriod = "LUNCH",
  opts: { channel?: OpsChannel } = {},
) {
  const activityChannel = opts.channel ?? "WEB_STOREFRONT";
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  const packed = await db.query.orders.findMany({
    where: (t, { eq: e, and: a }) =>
      a(
        e(t.cookId, cook.id),
        e(t.serviceDate, serviceDate),
        e(t.mealType, mealType),
        e(t.status, "PACKED"),
      ),
  });
  // Pickup orders skip dispatch — cook marks picked up (→ DELIVERED) instead.
  const toDispatch = packed.filter(
    (o) => o.fulfillmentMode !== "PICKUP" && o.fulfillmentMode !== "CUSTOMER_ARRANGE",
  );
  const { cookUsesPartnerDelivery, dispatchViaPartner } = await import("./partnerLogistics.js");
  const usePartner = await cookUsesPartnerDelivery(db, cook.id);

  const publicIds: string[] = [];
  let partnerAssigned = 0;
  for (const o of toDispatch) {
    if (usePartner) {
      const res = await dispatchViaPartner(db, o, cook);
      await notifyOrderStatus(db, o, res.status);
      publicIds.push(res.order.publicId);
      partnerAssigned += 1;
    } else {
      await transitionOrder(
        db,
        o.id,
        "DISPATCHED",
        { logisticsMode: "SELF" },
        { channel: activityChannel },
      );
      await notifyOrderStatus(db, o, "DISPATCHED");
      publicIds.push(o.publicId);
    }
  }
  return {
    dispatched: publicIds.length,
    partnerAssigned,
    skippedPickup: packed.length - toDispatch.length,
    publicIds,
  };
}

export async function markStartCooking(
  db: Db,
  cookSlug: string,
  serviceDate = serviceDateISO(),
  mealType: MealPeriod = "LUNCH",
  opts: { channel?: OpsChannel } = {},
) {
  const activityChannel = opts.channel ?? "WEB_STOREFRONT";
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  const paid = await db.query.orders.findMany({
    where: (t, { eq: e, and: a }) =>
      a(
        e(t.cookId, cook.id),
        e(t.serviceDate, serviceDate),
        e(t.mealType, mealType),
        e(t.status, "PAID"),
      ),
  });
  for (const o of paid) {
    await transitionOrder(db, o.id, "COOKING", undefined, { channel: activityChannel });
    await notifyOrderStatus(db, o, "COOKING");
  }
  return { cooking: paid.length, publicIds: paid.map((o) => o.publicId) };
}

export async function markDelivered(
  db: Db,
  orderPublicId: string,
  opts: {
    cookId?: string;
    channel?: "WHATSAPP_BOT" | "WEB_STOREFRONT" | "SYSTEM_CRON" | "ADMIN";
  } = {},
) {
  return advanceOrderKitchenStatus(db, orderPublicId, "DELIVERED", opts);
}

export async function findCookByMobile(db: Db, mobile: string) {
  const normalized = mobile.startsWith("+") ? mobile : `+${mobile.replace(/^\+/, "")}`;
  return db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, normalized),
  });
}

/** Today’s kitchen queue summary for WhatsApp cook status. */
export async function getCookDayStatus(db: Db, cookSlug: string, serviceDate = serviceDateISO()) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  const rows = await db.query.orders.findMany({
    where: (t, { eq: e, and: a, inArray: ia }) =>
      a(
        e(t.cookId, cook.id),
        e(t.serviceDate, serviceDate),
        ia(t.status, [
          "PAID",
          "CANCEL_REQUESTED",
          "COOKING",
          "PACKED",
          "DISPATCHED",
          "DELIVERED",
          "DELAYED",
        ]),
      ),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  return { cook, serviceDate, orders: rows };
}

export async function pauseCook(db: Db, cookId: string, reason: string) {
  const [updated] = await db
    .update(cookProfiles)
    .set({ isActive: false })
    .where(eq(cookProfiles.id, cookId))
    .returning();
  await db.insert(platformEventLedger).values({
    cookId,
    channel: "ADMIN",
    eventName: "COOK_PAUSED",
    rawPayload: { reason },
  });
  return updated;
}

async function requireCookBySlug(db: Db, cookSlug: string) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  return cook;
}

function weekdayFromISO(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** Dated items + weekly templates for cook desk. */
export async function listCookDailyMenu(
  db: Db,
  cookSlug: string,
  opts: { serviceDate?: string; view?: "day" | "week"; mealType?: MealPeriod } = {},
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const serviceDate = opts.serviceDate ?? serviceDateISO();
  const view = opts.view ?? "day";
  const mealType = opts.mealType ?? "LUNCH";

  const all = (
    await db.query.dailyMenus.findMany({
      where: (t, { eq: e }) => e(t.cookId, cook.id),
    })
  ).filter((m) => (m.mealType ?? "LUNCH") === mealType);

  if (view === "week") {
    const weekly = all
      .filter((m) => m.serviceDate == null && m.dayOfWeek != null)
      .sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0) || a.id - b.id);
    return {
      cook: { id: cook.id, kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
      serviceDate,
      mealType,
      mealLabel: mealLabel(mealType),
      view: "week" as const,
      menus: weekly,
      byDay: Object.fromEntries(
        [0, 1, 2, 3, 4, 5, 6].map((d) => [
          String(d),
          weekly.filter((m) => m.dayOfWeek === d),
        ]),
      ),
    };
  }

  const dow = weekdayFromISO(serviceDate);
  const dated = all.filter((m) => m.serviceDate === serviceDate);
  const weeklyForDay = all.filter(
    (m) => m.serviceDate == null && m.dayOfWeek === dow && m.isAvailable,
  );
  return {
    cook: { id: cook.id, kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
    serviceDate,
    mealType,
    mealLabel: mealLabel(mealType),
    dayOfWeek: dow,
    view: "day" as const,
    menus: dated,
    weeklyForDay,
  };
}

/** Publish a plate for a specific date and/or weekly weekday template. */
export async function addCookMenuItem(
  db: Db,
  cookSlug: string,
  input: {
    itemName: string;
    itemNameTa?: string | null;
    /** Rupees; converted to paise. Prefer pricePaise if both sent. */
    priceRupees?: number;
    pricePaise?: number;
    isVeg?: boolean;
    allergens?: string[];
    totalStockAvailable?: number;
    /** Specific calendar day (YYYY-MM-DD). Omit when posting weekly-only. */
    serviceDate?: string | null;
    /** 0=Sun … 6=Sat. When set without serviceDate → weekly recurring plate. */
    dayOfWeek?: number | null;
    imageUrl?: string | null;
    mealType?: "BREAKFAST" | "LUNCH" | "DINNER";
    /** Also upsert into cook saved-plates library for quick re-post. */
    saveToLibrary?: boolean;
  },
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const itemName = input.itemName.trim();
  if (!itemName) throw new Error("itemName is required");
  const itemNameTa = input.itemNameTa?.trim() || null;

  const pricePaise =
    input.pricePaise ??
    (input.priceRupees != null ? Math.round(Number(input.priceRupees) * 100) : undefined);
  if (pricePaise == null || !Number.isFinite(pricePaise) || pricePaise <= 0) {
    throw new Error("priceRupees or pricePaise is required");
  }

  const weeklyOnly = input.dayOfWeek != null && (input.serviceDate === null || input.serviceDate === "");
  if (weeklyOnly && (input.dayOfWeek! < 0 || input.dayOfWeek! > 6)) {
    throw new Error("dayOfWeek must be 0–6 (Sun–Sat)");
  }

  const serviceDate = weeklyOnly
    ? null
    : input.serviceDate === undefined
      ? serviceDateISO()
      : input.serviceDate;
  const dayOfWeek =
    input.dayOfWeek != null
      ? input.dayOfWeek
      : serviceDate
        ? weekdayFromISO(serviceDate)
        : null;

  const mealType = input.mealType ?? "LUNCH";
  const [row] = await db
    .insert(dailyMenus)
    .values({
      cookId: cook.id,
      itemName,
      itemNameTa,
      pricePaise,
      isVeg: input.isVeg ?? true,
      allergens: input.allergens ?? [],
      serviceDate,
      dayOfWeek,
      mealType,
      totalStockAvailable: input.totalStockAvailable ?? -1,
      isAvailable: true,
      itemType: "HOT_MEAL",
      imageUrl: input.imageUrl ?? null,
    })
    .returning();

  if (input.saveToLibrary) {
    await upsertCookSavedPlate(db, cook.id, {
      itemName,
      itemNameTa,
      pricePaise,
      isVeg: input.isVeg ?? true,
      imageUrl: input.imageUrl ?? null,
      mealType,
    });
  }

  await db.insert(platformEventLedger).values({
    cookId: cook.id,
    channel: "ADMIN",
    eventName: "COOK_MENU_ITEM_ADDED",
    rawPayload: {
      menuItemId: row.id,
      serviceDate,
      dayOfWeek,
      itemName,
      weekly: weeklyOnly,
      savedToLibrary: Boolean(input.saveToLibrary),
    },
  });

  await enqueueOutbox(db, "KitchenMenuPosted", {
      cookId: cook.id,
      cookSlug: cook.slugHandle,
      kitchenName: cook.kitchenName,
      menuItemId: row.id,
      itemName,
      pricePaise,
      isVeg: row.isVeg,
      serviceDate,
      dayOfWeek,
      mealType: row.mealType,
      weekly: weeklyOnly,
    });

  return row;
}

export async function updateCookMenuItem(
  db: Db,
  cookSlug: string,
  menuItemId: number,
  patch: {
    itemName?: string;
    itemNameTa?: string | null;
    priceRupees?: number;
    pricePaise?: number;
    isVeg?: boolean;
    allergens?: string[];
    totalStockAvailable?: number;
    isAvailable?: boolean;
    imageUrl?: string | null;
    dayOfWeek?: number | null;
    serviceDate?: string | null;
  },
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const existing = await db.query.dailyMenus.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.id, menuItemId), e(t.cookId, cook.id)),
  });
  if (!existing) throw new Error("Menu item not found");

  const pricePaise =
    patch.pricePaise ??
    (patch.priceRupees != null ? Math.round(Number(patch.priceRupees) * 100) : undefined);

  const [row] = await db
    .update(dailyMenus)
    .set({
      ...(patch.itemName != null ? { itemName: patch.itemName.trim() } : {}),
      ...(patch.itemNameTa !== undefined
        ? { itemNameTa: patch.itemNameTa?.trim() || null }
        : {}),
      ...(pricePaise != null ? { pricePaise } : {}),
      ...(patch.isVeg != null ? { isVeg: patch.isVeg } : {}),
      ...(patch.allergens != null ? { allergens: patch.allergens } : {}),
      ...(patch.totalStockAvailable != null
        ? { totalStockAvailable: patch.totalStockAvailable }
        : {}),
      ...(patch.isAvailable != null ? { isAvailable: patch.isAvailable } : {}),
      ...(patch.imageUrl !== undefined ? { imageUrl: patch.imageUrl } : {}),
      ...(patch.dayOfWeek !== undefined ? { dayOfWeek: patch.dayOfWeek } : {}),
      ...(patch.serviceDate !== undefined ? { serviceDate: patch.serviceDate } : {}),
    })
    .where(and(eq(dailyMenus.id, menuItemId), eq(dailyMenus.cookId, cook.id)))
    .returning();

  return row;
}

/** Permanently remove a plate (dated or weekly template) from this kitchen. */
export async function deleteCookMenuItem(db: Db, cookSlug: string, menuItemId: number) {
  const cook = await requireCookBySlug(db, cookSlug);
  const existing = await db.query.dailyMenus.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.id, menuItemId), e(t.cookId, cook.id)),
  });
  if (!existing) throw new Error("Menu item not found");
  // Orders keep itemName snapshots; clear FK so delete is allowed.
  await db
    .update(orders)
    .set({ menuItemId: null })
    .where(eq(orders.menuItemId, menuItemId));
  await db
    .delete(dailyMenus)
    .where(and(eq(dailyMenus.id, menuItemId), eq(dailyMenus.cookId, cook.id)));
  return { ok: true as const, id: menuItemId };
}

async function upsertCookSavedPlate(
  db: Db,
  cookId: string,
  plate: {
    itemName: string;
    itemNameTa?: string | null;
    pricePaise: number;
    isVeg?: boolean;
    imageUrl?: string | null;
    mealType?: MealPeriod;
  },
) {
  const itemName = plate.itemName.trim();
  const mealType = plate.mealType ?? "LUNCH";
  const existing = await db.query.cookSavedPlates.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.cookId, cookId), e(t.mealType, mealType), e(t.itemName, itemName)),
  });
  if (existing) {
    const [row] = await db
      .update(cookSavedPlates)
      .set({
        itemNameTa: plate.itemNameTa?.trim() || null,
        pricePaise: plate.pricePaise,
        isVeg: plate.isVeg ?? true,
        imageUrl: plate.imageUrl ?? null,
        updatedAt: new Date(),
      })
      .where(eq(cookSavedPlates.id, existing.id))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(cookSavedPlates)
    .values({
      cookId,
      itemName,
      itemNameTa: plate.itemNameTa?.trim() || null,
      pricePaise: plate.pricePaise,
      isVeg: plate.isVeg ?? true,
      imageUrl: plate.imageUrl ?? null,
      mealType,
    })
    .returning();
  return row;
}

export async function listCookSavedPlates(
  db: Db,
  cookSlug: string,
  mealType: MealPeriod = "LUNCH",
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const rows = await db.query.cookSavedPlates.findMany({
    where: (t, { eq: e, and: a }) => a(e(t.cookId, cook.id), e(t.mealType, mealType)),
    orderBy: (t, { asc }) => [asc(t.itemName)],
  });
  return {
    cookSlug,
    mealType,
    plates: rows.map((r) => ({
      id: r.id,
      itemName: r.itemName,
      itemNameTa: r.itemNameTa,
      pricePaise: r.pricePaise,
      isVeg: r.isVeg,
      imageUrl: r.imageUrl,
      mealType: r.mealType,
      updatedAt: r.updatedAt,
    })),
  };
}

export async function saveCookSavedPlate(
  db: Db,
  cookSlug: string,
  input: {
    itemName?: string;
    itemNameTa?: string | null;
    priceRupees?: number;
    pricePaise?: number;
    isVeg?: boolean;
    imageUrl?: string | null;
    mealType?: MealPeriod;
    /** Copy fields from an existing live menu row. */
    fromMenuId?: number;
  },
) {
  const cook = await requireCookBySlug(db, cookSlug);
  let itemName = input.itemName?.trim() ?? "";
  let itemNameTa = input.itemNameTa?.trim() || null;
  let pricePaise =
    input.pricePaise ??
    (input.priceRupees != null ? Math.round(Number(input.priceRupees) * 100) : undefined);
  let isVeg = input.isVeg ?? true;
  let imageUrl = input.imageUrl ?? null;
  let mealType: MealPeriod = input.mealType ?? "LUNCH";

  if (input.fromMenuId != null) {
    const menu = await db.query.dailyMenus.findFirst({
      where: (t, { eq: e, and: a }) => a(e(t.id, input.fromMenuId!), e(t.cookId, cook.id)),
    });
    if (!menu) throw new Error("Menu item not found");
    itemName = menu.itemName;
    itemNameTa = menu.itemNameTa;
    pricePaise = menu.pricePaise;
    isVeg = menu.isVeg;
    imageUrl = menu.imageUrl;
    mealType = (menu.mealType as MealPeriod) || "LUNCH";
  }

  if (!itemName) throw new Error("itemName is required");
  if (pricePaise == null || !Number.isFinite(pricePaise) || pricePaise <= 0) {
    throw new Error("priceRupees or pricePaise is required");
  }

  return upsertCookSavedPlate(db, cook.id, {
    itemName,
    itemNameTa,
    pricePaise,
    isVeg,
    imageUrl,
    mealType,
  });
}

export async function deleteCookSavedPlate(db: Db, cookSlug: string, savedId: number) {
  const cook = await requireCookBySlug(db, cookSlug);
  const existing = await db.query.cookSavedPlates.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.id, savedId), e(t.cookId, cook.id)),
  });
  if (!existing) throw new Error("Saved plate not found");
  await db
    .delete(cookSavedPlates)
    .where(and(eq(cookSavedPlates.id, savedId), eq(cookSavedPlates.cookId, cook.id)));
  return { ok: true as const, id: savedId };
}

/** One-tap: copy a saved plate onto a date or as a weekly template. */
export async function postCookSavedPlate(
  db: Db,
  cookSlug: string,
  savedId: number,
  opts: {
    serviceDate?: string | null;
    weekly?: boolean;
    dayOfWeek?: number | null;
  } = {},
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const saved = await db.query.cookSavedPlates.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.id, savedId), e(t.cookId, cook.id)),
  });
  if (!saved) throw new Error("Saved plate not found");

  const weekly = Boolean(opts.weekly);
  const anchorDate = opts.serviceDate || serviceDateISO();
  const serviceDate = weekly ? null : anchorDate;
  const dayOfWeek = weekly
    ? (opts.dayOfWeek ?? weekdayFromISO(anchorDate))
    : undefined;

  if (weekly && (dayOfWeek == null || dayOfWeek < 0 || dayOfWeek > 6)) {
    throw new Error("dayOfWeek required for weekly post");
  }

  return addCookMenuItem(db, cookSlug, {
    itemName: saved.itemName,
    itemNameTa: saved.itemNameTa,
    pricePaise: saved.pricePaise,
    isVeg: saved.isVeg,
    imageUrl: saved.imageUrl,
    mealType: saved.mealType as MealPeriod,
    serviceDate,
    dayOfWeek: weekly ? dayOfWeek : undefined,
    saveToLibrary: false,
  });
}

function normalizeTemplateItems(raw: unknown): CookMenuTemplateItem[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Add at least one plate to the template");
  }
  if (raw.length > 12) throw new Error("Templates are limited to 12 plates");
  return raw.map((item, i) => {
    const row = item as Partial<CookMenuTemplateItem>;
    const itemName = String(row.itemName ?? "").trim();
    if (!itemName) throw new Error(`Plate ${i + 1} needs a name`);
    const pricePaise = Number(row.pricePaise);
    if (!Number.isFinite(pricePaise) || pricePaise < 1) {
      throw new Error(`Plate ${i + 1} needs a price`);
    }
    return {
      itemName: itemName.slice(0, 100),
      itemNameTa: row.itemNameTa?.trim()?.slice(0, 100) || null,
      pricePaise: Math.round(pricePaise),
      isVeg: row.isVeg !== false,
      imageUrl: row.imageUrl?.trim() || null,
    };
  });
}

export async function listCookMenuTemplates(
  db: Db,
  cookSlug: string,
  mealType: MealPeriod = "LUNCH",
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const rows = await db.query.cookMenuTemplates.findMany({
    where: (t, { eq: e, and: a }) => a(e(t.cookId, cook.id), e(t.mealType, mealType)),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
  return {
    templates: rows.map((r) => ({
      id: r.id,
      name: r.name,
      mealType: r.mealType,
      items: (r.items ?? []) as CookMenuTemplateItem[],
      itemCount: Array.isArray(r.items) ? r.items.length : 0,
      updatedAt: r.updatedAt,
    })),
  };
}

export async function saveCookMenuTemplate(
  db: Db,
  cookSlug: string,
  input: {
    name: string;
    mealType?: MealPeriod;
    items?: CookMenuTemplateItem[];
    /** Snapshot current day menu into the template. */
    fromServiceDate?: string | null;
  },
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const mealType = input.mealType ?? "LUNCH";
  const name = input.name.trim().slice(0, 80);
  if (name.length < 2) throw new Error("Template name must be at least 2 characters");

  let items: CookMenuTemplateItem[];
  if (input.fromServiceDate) {
    const serviceDate = input.fromServiceDate;
    const menus = await db.query.dailyMenus.findMany({
      where: (t, { eq: e, and: a }) =>
        a(e(t.cookId, cook.id), e(t.mealType, mealType), e(t.serviceDate, serviceDate)),
    });
    items = normalizeTemplateItems(
      menus.map((m) => ({
        itemName: m.itemName,
        itemNameTa: m.itemNameTa,
        pricePaise: m.pricePaise,
        isVeg: m.isVeg,
        imageUrl: m.imageUrl,
      })),
    );
  } else {
    items = normalizeTemplateItems(input.items);
  }

  const existing = await db.query.cookMenuTemplates.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.cookId, cook.id), e(t.mealType, mealType), e(t.name, name)),
  });
  if (existing) {
    const [updated] = await db
      .update(cookMenuTemplates)
      .set({ items, updatedAt: new Date() })
      .where(eq(cookMenuTemplates.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db
    .insert(cookMenuTemplates)
    .values({ cookId: cook.id, name, mealType, items })
    .returning();
  return created;
}

export async function deleteCookMenuTemplate(db: Db, cookSlug: string, templateId: number) {
  const cook = await requireCookBySlug(db, cookSlug);
  const existing = await db.query.cookMenuTemplates.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.id, templateId), e(t.cookId, cook.id)),
  });
  if (!existing) throw new Error("Template not found");
  await db
    .delete(cookMenuTemplates)
    .where(and(eq(cookMenuTemplates.id, templateId), eq(cookMenuTemplates.cookId, cook.id)));
  return { ok: true as const, id: templateId };
}

/** One-tap: post every plate in a named template to a date or weekly day. */
export async function postCookMenuTemplate(
  db: Db,
  cookSlug: string,
  templateId: number,
  opts: {
    serviceDate?: string | null;
    weekly?: boolean;
    dayOfWeek?: number | null;
  } = {},
) {
  const cook = await requireCookBySlug(db, cookSlug);
  const template = await db.query.cookMenuTemplates.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.id, templateId), e(t.cookId, cook.id)),
  });
  if (!template) throw new Error("Template not found");
  const items = (template.items ?? []) as CookMenuTemplateItem[];
  if (!items.length) throw new Error("Template has no plates");

  const weekly = Boolean(opts.weekly);
  const anchorDate = opts.serviceDate || serviceDateISO();
  const serviceDate = weekly ? null : anchorDate;
  const dayOfWeek = weekly
    ? (opts.dayOfWeek ?? weekdayFromISO(anchorDate))
    : undefined;
  if (weekly && (dayOfWeek == null || dayOfWeek < 0 || dayOfWeek > 6)) {
    throw new Error("dayOfWeek required for weekly post");
  }

  const posted = [];
  for (const item of items) {
    posted.push(
      await addCookMenuItem(db, cookSlug, {
        itemName: item.itemName,
        itemNameTa: item.itemNameTa,
        pricePaise: item.pricePaise,
        isVeg: item.isVeg,
        imageUrl: item.imageUrl,
        mealType: template.mealType as MealPeriod,
        serviceDate,
        dayOfWeek: weekly ? dayOfWeek : undefined,
        saveToLibrary: false,
      }),
    );
  }
  return { ok: true as const, count: posted.length, items: posted };
}
