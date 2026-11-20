import { createHash, randomBytes } from "node:crypto";
import { and, eq, inArray, lt } from "drizzle-orm";
import {
  addresses,
  orders,
  payments,
  platformEventLedger,
  users,
  type Db,
} from "@localmeals/db";
import {
  LogEvent,
  bindTrace,
  createServiceLogger,
  newTraceId,
  orderTriageFields,
} from "@localmeals/observability";
import { enqueueOutbox } from "./outboxEnqueue.js";

const orderLog = createServiceLogger("localmeals-api");
import {
  assertCanAcceptPaidOrders,
  assertFulfillmentAllowed,
  assertIntakeOpen,
  assertSelfDeliveryAllowed,
  assertTransition,
  buildIdempotencyKey,
  addDaysISO,
  cookFulfillmentOffersFromRow,
  dayOfWeekForServiceDate,
  formatCutoffLabel,
  formatDeliveryWindowLabel,
  isBeforeCutoff,
  isIntakePausedForDate,
  isFeatureEnabled,
  isZeroDeliveryFulfillment,
  lineFoodDiscountPaise,
  mealLabel,
  normalizeFulfillmentMode,
  normalizeWeekDiscountRule,
  orderTotalPaise,
  parseServiceDate,
  resolveMealSchedule,
  resolveSelfDeliveryPaise,
  serviceDateISO,
  weekDiscountApplies,
  WEEKDAY_SHORT,
  aggregateCheckoutStatus,
  type FulfillmentMode,
  type MealPeriod,
  type MealSettingsRow,
  type OrderState,
} from "@localmeals/domain";
import { getPaymentProvider } from "@localmeals/adapters";
import {
  platformFeePaise,
  platformFeePaiseForCheckoutLine,
} from "../soloKitchen.js";

/**
 * Customer-facing kitchen card — never include cook personal mobile or payout rails.
 * (Docs: cook personal mobile must not be exposed to customers.)
 */
export function publicCookDto(cook: {
  id: string;
  kitchenName: string;
  slugHandle: string;
  pinCode: string;
  lat?: string | null;
  lng?: string | null;
  deliveryType?: string | null;
  flatSelfDeliveryFee?: string | number | null;
  fssaiNumber?: string | null;
  fssaiVerifiedAt?: Date | null;
  weekDiscountPercent?: number | null;
  weekDiscountMinDays?: number | null;
  pickupEnabled?: boolean | null;
  intakePausedDate?: string | null;
  offerCookDelivery?: boolean | null;
  offerCustomerArrange?: boolean | null;
}) {
  const offers = cookFulfillmentOffersFromRow(cook);
  const today = serviceDateISO();
  return {
    id: cook.id,
    kitchenName: cook.kitchenName,
    slugHandle: cook.slugHandle,
    pinCode: cook.pinCode,
    lat: cook.lat ?? null,
    lng: cook.lng ?? null,
    deliveryType: cook.deliveryType ?? "SELF",
    flatSelfDeliveryFee: cook.flatSelfDeliveryFee ?? "25.00",
    fssaiNumber: cook.fssaiNumber ?? null,
    fssaiVerifiedAt: cook.fssaiVerifiedAt ?? null,
    weekDiscountPercent: cook.weekDiscountPercent ?? 0,
    weekDiscountMinDays: cook.weekDiscountMinDays ?? 3,
    pickupEnabled: Boolean(cook.pickupEnabled),
    intakePaused: isIntakePausedForDate(cook.intakePausedDate, today),
    intakePausedDate: cook.intakePausedDate ?? null,
    fulfillmentOffers: offers,
  };
}

const ALREADY_PAID: OrderState[] = [
  "PAID",
  "COOKING",
  "PACKED",
  "DISPATCHED",
  "DELAYED",
  "DELIVERED",
];

function publicId() {
  // 10 hex chars ≈ 40 bits entropy — harder to enumerate than short time+3-digit ids.
  return `LM-${randomBytes(5).toString("hex").toUpperCase()}`;
}

function checkoutPublicId() {
  return `CHK-${randomBytes(5).toString("hex").toUpperCase()}`;
}

/**
 * HTTP `Idempotency-Key` → DB key scoped to the customer so keys cannot collide across accounts.
 * Max 128 chars of client key (trimmed).
 */
export function httpIdempotencyKey(customerMobile: string, headerKey: string): string {
  const trimmed = headerKey.trim().slice(0, 128);
  if (!trimmed) throw new Error("Idempotency-Key cannot be empty");
  return `hdr|${createHash("sha256")
    .update(`${customerMobile}|${trimmed}`)
    .digest("hex")
    .slice(0, 48)}`;
}

function paymentUrlFor(order: { publicId: string; gatewayTxnId: string | null }) {
  if (!order.gatewayTxnId) return undefined;
  const base = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  return `${base}/pay/${order.publicId}?txn=${order.gatewayTxnId}`;
}

function paymentUrlForCheckout(checkoutId: string, gatewayTxnId: string) {
  const base = process.env.WEB_ORIGIN ?? "http://localhost:3000";
  return `${base}/pay/${checkoutId}?txn=${gatewayTxnId}`;
}

function isLiveGatewayTxn(gatewayTxnId: string | null | undefined) {
  return Boolean(gatewayTxnId && !gatewayTxnId.startsWith("mock_"));
}

/** Razorpay short_url is stored on ORDER_CREATED / LATE_ORDER_ACCEPTED ledger rows. */
async function paymentUrlFromLedger(db: Db, orderId: number): Promise<string | undefined> {
  const rows = await db.query.platformEventLedger.findMany({
    where: (t, { eq: e }) => e(t.orderId, orderId),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 25,
  });
  for (const row of rows) {
    const payload = row.rawPayload as { paymentUrl?: unknown } | null;
    if (payload && typeof payload.paymentUrl === "string" && payload.paymentUrl.length > 0) {
      return payload.paymentUrl;
    }
  }
  return undefined;
}

export async function resolveCustomerPaymentUrl(
  db: Db,
  opts: {
    orderId: number;
    publicId: string;
    gatewayTxnId: string | null;
    checkoutId?: string | null;
  },
): Promise<string | undefined> {
  if (!opts.gatewayTxnId) return undefined;
  if (isLiveGatewayTxn(opts.gatewayTxnId)) {
    const stored = await paymentUrlFromLedger(db, opts.orderId);
    if (stored) return stored;
  }
  if (opts.checkoutId) {
    return paymentUrlForCheckout(opts.checkoutId, opts.gatewayTxnId);
  }
  return paymentUrlFor({ publicId: opts.publicId, gatewayTxnId: opts.gatewayTxnId });
}

function lineTotal(o: {
  foodPaise: number;
  deliveryPaise: number;
  platformFeePaise: number;
  qty: number;
  foodDiscountPaise?: number | null;
}) {
  return orderTotalPaise({
    ...o,
    foodDiscountPaise: o.foodDiscountPaise ?? 0,
  });
}

export async function loadMealSettingsRows(db: Db, cookId: string): Promise<MealSettingsRow[]> {
  const rows = await db.query.cookMealSettings.findMany({
    where: (t, { eq: e }) => e(t.cookId, cookId),
  });
  return rows.map((r) => ({
    mealType: r.mealType as MealPeriod,
    enabled: r.enabled,
    cutoffHour: r.cutoffHour,
    cutoffMinute: r.cutoffMinute,
    deliveryStartHour: r.deliveryStartHour,
    deliveryStartMinute: r.deliveryStartMinute,
    deliveryEndHour: r.deliveryEndHour,
    deliveryEndMinute: r.deliveryEndMinute,
  }));
}

export async function scheduleForCook(
  db: Db,
  cook: {
    id: string;
    lunchCutoffHour?: number | null;
    lunchCutoffMinute?: number | null;
    deliveryWindowStartHour?: number | null;
    deliveryWindowStartMinute?: number | null;
    deliveryWindowEndHour?: number | null;
    deliveryWindowEndMinute?: number | null;
  },
  meal: MealPeriod,
) {
  const rows = await loadMealSettingsRows(db, cook.id);
  return resolveMealSchedule(meal, rows, cook);
}

export type { FulfillmentMode };

function isPickupMode(mode: string | null | undefined): mode is "PICKUP" {
  return mode === "PICKUP";
}

/** Resolve checkout mode against cook offers + platform pickup gate. */
async function resolveCheckoutFulfillment(
  db: Db,
  cook: {
    pickupEnabled?: boolean | null;
    pickupLandmark?: string | null;
    offerCookDelivery?: boolean | null;
    offerCustomerArrange?: boolean | null;
    flatSelfDeliveryFee?: string | number | null;
  },
  inputMode: FulfillmentMode | string | null | undefined,
) {
  const fulfillmentMode = normalizeFulfillmentMode(inputMode);
  const offers = cookFulfillmentOffersFromRow(cook);
  const pickup = await resolvePickupAvailability(db, cook);
  assertFulfillmentAllowed(fulfillmentMode, offers, {
    pickupPlatformAvailable: pickup.available,
  });
  let pickupLandmark: string | null = null;
  if (fulfillmentMode === "PICKUP") {
    const { assertFeatureEnabled } = await import("./featureFlags.js");
    await assertFeatureEnabled(
      db,
      "pickup_enabled",
      "Pickup is not available right now — choose delivery",
    );
    if (!pickup.available || !pickup.landmark) {
      throw new Error("This kitchen is not offering pickup right now");
    }
    pickupLandmark = pickup.landmark;
  }
  let deliveryPaise = 0;
  if (!isZeroDeliveryFulfillment(fulfillmentMode)) {
    const { getFeatureFlags } = await import("./featureFlags.js");
    const flags = await getFeatureFlags(db);
    deliveryPaise = isFeatureEnabled(flags, "self_delivery_fee_enabled")
      ? Math.round(Number(cook.flatSelfDeliveryFee) * 100)
      : 0;
  }
  return { fulfillmentMode, pickupLandmark, deliveryPaise, offers, pickup };
}

/**
 * When Admin flag `delivery_distance_limits_enabled` is on: free ≤3 km, flat fee ≤5 km,
 * block cook delivery beyond / without lat-lng. Flag off → keep flat fee.
 */
async function applyDeliveryDistancePaise(
  db: Db,
  input: {
    cook: { lat?: string | number | null; lng?: string | number | null };
    address: {
      lat?: string | number | null;
      lng?: string | number | null;
      pinCode?: string | null;
    };
    fulfillmentMode: FulfillmentMode;
    baseDeliveryPaise: number;
  },
): Promise<number> {
  const { getFeatureFlags } = await import("./featureFlags.js");
  const flags = await getFeatureFlags(db);
  const resolved = resolveSelfDeliveryPaise({
    distanceLimitsEnabled: isFeatureEnabled(flags, "delivery_distance_limits_enabled"),
    fulfillmentMode: input.fulfillmentMode,
    flatSelfDeliveryFeePaise: input.baseDeliveryPaise,
    cookLat: input.cook.lat,
    cookLng: input.cook.lng,
    addressLat: input.address.lat,
    addressLng: input.address.lng,
    addressPinCode: input.address.pinCode,
  });
  assertSelfDeliveryAllowed(resolved.band);
  return resolved.deliveryPaise;
}

/** Platform flag + cook opt-in + landmark required. */
export async function resolvePickupAvailability(
  db: Db,
  cook: {
    pickupEnabled?: boolean | null;
    pickupLandmark?: string | null;
  },
) {
  const { getFeatureFlags } = await import("./featureFlags.js");
  const flags = await getFeatureFlags(db);
  const landmark = cook.pickupLandmark?.trim() || null;
  const available = Boolean(
    flags.pickup_enabled && cook.pickupEnabled && landmark,
  );
  return { available, landmark, platformEnabled: flags.pickup_enabled };
}

/** Landmark + code only after payment (or later kitchen statuses). */
const PAID_LIKE_FOR_PICKUP = new Set([
  "PAID",
  "COOKING",
  "PACKED",
  "DISPATCHED",
  "DELAYED",
  "DELIVERED",
]);

export function pickupRevealForOrder(order: {
  fulfillmentMode?: string | null;
  status: string;
  publicId: string;
  deliveryTargetAddress?: string | null;
}) {
  if (!isPickupMode(order.fulfillmentMode)) return null;
  if (!PAID_LIKE_FOR_PICKUP.has(order.status)) {
    return {
      fulfillmentMode: "PICKUP" as const,
      landmark: null as string | null,
      pickupCode: order.publicId,
      revealAfterPay: true,
    };
  }
  const raw = order.deliveryTargetAddress ?? "";
  const landmark = raw.replace(/^Pickup\s*·\s*/i, "").trim() || raw;
  return {
    fulfillmentMode: "PICKUP" as const,
    landmark,
    pickupCode: order.publicId,
    revealAfterPay: false,
  };
}

/** Next service date still before cut-off for this meal (today or later). */
export async function nextOpenSlotForCook(
  db: Db,
  cook: { id: string } & Record<string, unknown>,
  mealType: MealPeriod = "LUNCH",
) {
  const schedule = await scheduleForCook(db, cook as never, mealType);
  if (!schedule.enabled) {
    return {
      orderingOpen: false,
      nextServiceDate: null as string | null,
      cutoffLabel: formatCutoffLabel(schedule.cutoff),
      deliveryWindow: formatDeliveryWindowLabel(schedule.deliveryWindow),
      statusLabel: `${mealLabel(mealType)} not offered`,
    };
  }
  const today = serviceDateISO();
  for (let i = 0; i <= 7; i++) {
    const d = addDaysISO(today, i);
    if (isBeforeCutoff(mealType, new Date(), d, schedule.cutoff)) {
      return {
        orderingOpen: i === 0,
        nextServiceDate: d,
        cutoffLabel: formatCutoffLabel(schedule.cutoff),
        deliveryWindow: formatDeliveryWindowLabel(schedule.deliveryWindow),
        statusLabel:
          i === 0
            ? `Open · order by ${formatCutoffLabel(schedule.cutoff)}`
            : `Closed · next ${d} · by ${formatCutoffLabel(schedule.cutoff)}`,
      };
    }
  }
  return {
    orderingOpen: false,
    nextServiceDate: null as string | null,
    cutoffLabel: formatCutoffLabel(schedule.cutoff),
    deliveryWindow: formatDeliveryWindowLabel(schedule.deliveryWindow),
    statusLabel: `Closed · cut-off ${formatCutoffLabel(schedule.cutoff)} passed for this week`,
  };
}

export async function listKitchens(db: Db, pinCode?: string) {
  const rows = await db.query.cookProfiles.findMany();
  const { getCookReviewSummary } = await import("./reviews.js");
  const { soloKitchenSlug } = await import("../soloKitchen.js");
  const soloOnly = soloKitchenSlug();
  const weekStart = addDaysISO(serviceDateISO(), -6);
  const out = [];
  for (const c of rows) {
    if (soloOnly && c.slugHandle !== soloOnly) continue;
    if (
      !(
        c.onboardingStatus === "LIVE" &&
        c.isActive &&
        c.fssaiNumber &&
        (!pinCode || c.pinCode === pinCode)
      )
    ) {
      continue;
    }
    const schedule = await scheduleForCook(db, c, "LUNCH");
    const slot = await nextOpenSlotForCook(db, c, "LUNCH");
    const reviews = await getCookReviewSummary(db, c.id);
    const menus = await db.query.dailyMenus.findMany({
      where: (t, { eq: e }) => e(t.cookId, c.id),
      limit: 40,
    });
    const withPhoto = menus.find((m) => m.isAvailable && m.imageUrl?.trim());
    const weekOrders = await db.query.orders.findMany({
      where: (t, { eq: e, and: a, gte: g, inArray: ia }) =>
        a(
          e(t.cookId, c.id),
          g(t.serviceDate, weekStart),
          ia(t.status, [
            "PAID",
            "COOKING",
            "PACKED",
            "DISPATCHED",
            "DELAYED",
            "DELIVERED",
          ]),
        ),
      limit: 200,
    });
    const platesThisWeek = weekOrders.reduce((n, o) => n + o.qty, 0);
    out.push({
      ...publicCookDto(c),
      lunchCutoff: formatCutoffLabel(schedule.cutoff),
      deliveryWindow: formatDeliveryWindowLabel(schedule.deliveryWindow),
      orderingOpen: slot.orderingOpen,
      nextServiceDate: slot.nextServiceDate,
      openStatusLabel: slot.statusLabel,
      mealType: "LUNCH" as const,
      coverImageUrl: withPhoto?.imageUrl ?? null,
      platesThisWeek,
      reviews: reviews.public
        ? { average: reviews.average, count: reviews.count, public: true }
        : { average: null, count: reviews.count, public: false },
    });
  }
  // Open kitchens first
  out.sort((a, b) => Number(b.orderingOpen) - Number(a.orderingOpen));
  return out;
}

function menusForServiceDate(
  rows: Array<{
    serviceDate: string | null;
    dayOfWeek: number | null;
    isAvailable: boolean;
    itemName: string;
    mealType?: string;
  }>,
  serviceDate: string,
  mealType: MealPeriod = "LUNCH",
) {
  const dayOfWeek = dayOfWeekForServiceDate(serviceDate);
  const forMeal = rows.filter((r) => (r.mealType ?? "LUNCH") === mealType);
  const dated = forMeal.filter((r) => r.serviceDate === serviceDate && r.isAvailable);
  const weekly = forMeal.filter(
    (r) => r.serviceDate == null && r.dayOfWeek === dayOfWeek && r.isAvailable,
  );
  const datedNames = new Set(dated.map((r) => r.itemName.toLowerCase()));
  return [...dated, ...weekly.filter((r) => !datedNames.has(r.itemName.toLowerCase()))];
}

export async function getKitchenMenu(
  db: Db,
  slug: string,
  serviceDate = serviceDateISO(),
  mealType: MealPeriod = "LUNCH",
) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, slug),
  });
  if (!cook) return null;
  const schedule = await scheduleForCook(db, cook, mealType);
  if (!schedule.enabled) {
    return {
      cook: publicCookDto(cook),
      menus: [],
      serviceDate,
      mealType,
      mealLabel: mealLabel(mealType),
      dayOfWeek: dayOfWeekForServiceDate(serviceDate),
      dayLabel: WEEKDAY_SHORT[dayOfWeekForServiceDate(serviceDate)],
      lunchCutoff: formatCutoffLabel(schedule.cutoff),
      cutoff: formatCutoffLabel(schedule.cutoff),
      deliveryWindow: formatDeliveryWindowLabel(schedule.deliveryWindow),
      orderingOpen: false,
      mealEnabled: false,
    };
  }
  const dayOfWeek = dayOfWeekForServiceDate(serviceDate);
  const rows = await db.query.dailyMenus.findMany({
    where: (t, { eq: e }) => e(t.cookId, cook.id),
  });
  const menus = menusForServiceDate(rows, serviceDate, mealType);
  return {
    cook: publicCookDto(cook),
    menus,
    serviceDate,
    mealType,
    mealLabel: mealLabel(mealType),
    dayOfWeek,
    dayLabel: WEEKDAY_SHORT[dayOfWeek],
    lunchCutoff: formatCutoffLabel(schedule.cutoff),
    cutoff: formatCutoffLabel(schedule.cutoff),
    deliveryWindow: formatDeliveryWindowLabel(schedule.deliveryWindow),
    orderingOpen: isBeforeCutoff(mealType, new Date(), serviceDate, schedule.cutoff),
    mealEnabled: true,
  };
}

/** Advance order: which meals have open days with plates in the next week. */
export async function getKitchenAdvanceMealOptions(
  db: Db,
  slug: string,
  opts: { days?: number } = {},
) {
  const days = opts.days ?? 7;
  const meals: Array<{
    mealType: MealPeriod;
    mealLabel: string;
    openDayCount: number;
    sampleItem: string | null;
  }> = [];

  for (const mealType of ["BREAKFAST", "LUNCH", "DINNER"] as MealPeriod[]) {
    const week = await getKitchenWeekPlan(db, slug, { days, mealType });
    if (!week || week.mealEnabled === false) continue;
    const openDays = week.plan.filter((d) => d.orderingOpen && d.menus.length > 0);
    if (!openDays.length) continue;
    meals.push({
      mealType,
      mealLabel: week.mealLabel,
      openDayCount: openDays.length,
      sampleItem: openDays[0]?.menus[0]?.itemName ?? null,
    });
  }

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, slug),
  });
  if (!cook) return null;
  return {
    cook: { kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
    days,
    meals,
  };
}

/** Next N calendar days of menus for a meal (dated + weekly templates). */
export async function getKitchenWeekPlan(
  db: Db,
  slug: string,
  opts: { from?: string; days?: number; mealType?: MealPeriod } = {},
) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, slug),
  });
  if (!cook) return null;

  const mealType = opts.mealType ?? "LUNCH";
  const schedule = await scheduleForCook(db, cook, mealType);
  const from = opts.from ?? serviceDateISO();
  const days = Math.min(Math.max(opts.days ?? 7, 1), 14);
  const rows = await db.query.dailyMenus.findMany({
    where: (t, { eq: e }) => e(t.cookId, cook.id),
  });
  const cutoffLabel = formatCutoffLabel(schedule.cutoff);
  const deliveryWindowLabel = formatDeliveryWindowLabel(schedule.deliveryWindow);

  const plan = Array.from({ length: days }, (_, i) => {
    const serviceDate = addDaysISO(from, i);
    const dayOfWeek = dayOfWeekForServiceDate(serviceDate);
    const menus = schedule.enabled ? menusForServiceDate(rows, serviceDate, mealType) : [];
    return {
      serviceDate,
      dayOfWeek,
      dayLabel: WEEKDAY_SHORT[dayOfWeek],
      isToday: serviceDate === serviceDateISO(),
      orderingOpen:
        schedule.enabled && isBeforeCutoff(mealType, new Date(), serviceDate, schedule.cutoff),
      itemCount: menus.length,
      menus,
    };
  });

  const { getCookReviewSummary } = await import("./reviews.js");
  const reviewSummary = await getCookReviewSummary(db, cook.id);
  const { getFeatureFlags } = await import("./featureFlags.js");
  const flags = await getFeatureFlags(db);
  const { normalizeWeekDiscountRule, describeWeekDiscount } = await import("@localmeals/domain");
  const weekDiscount = normalizeWeekDiscountRule({
    percent: flags.week_discount_enabled ? cook.weekDiscountPercent : 0,
    minDays: cook.weekDiscountMinDays,
  });
  const slot = await nextOpenSlotForCook(db, cook, mealType);
  const pickup = await resolvePickupAvailability(db, cook);
  const offers = cookFulfillmentOffersFromRow(cook);
  const todayPaused = isIntakePausedForDate(cook.intakePausedDate, serviceDateISO());
  const orderingOpen = slot.orderingOpen && !todayPaused;

  return {
    cook: publicCookDto(cook),
    from,
    days,
    mealType,
    mealLabel: mealLabel(mealType),
    mealEnabled: schedule.enabled,
    lunchCutoff: cutoffLabel,
    cutoff: cutoffLabel,
    deliveryWindow: deliveryWindowLabel,
    orderingOpen,
    intakePaused: todayPaused,
    nextServiceDate: slot.nextServiceDate,
    openStatusLabel: todayPaused ? "Paused for today" : slot.statusLabel,
    fulfillmentOffers: {
      cookDelivery: offers.cookDelivery,
      pickup: pickup.available,
      customerArrange: offers.customerArrange,
    },
    pickup: {
      available: pickup.available,
      /** Same restricted window as delivery for this meal. */
      window: deliveryWindowLabel,
      hint: pickup.available
        ? `Pickup during ${deliveryWindowLabel} · landmark after pay · show order code`
        : null,
    },
    plan: plan.map((day) => ({
      ...day,
      orderingOpen:
        day.orderingOpen && !isIntakePausedForDate(cook.intakePausedDate, day.serviceDate),
    })),
    weekDiscount: {
      ...weekDiscount,
      label: describeWeekDiscount(weekDiscount),
    },
    reviews: reviewSummary.public
      ? { average: reviewSummary.average, count: reviewSummary.count, public: true }
      : { average: null, count: reviewSummary.count, public: false },
  };
}

function assertMenuAppliesToDate(
  menu: { serviceDate: string | null; dayOfWeek: number | null; itemName: string },
  serviceDate: string,
) {
  if (menu.serviceDate != null) {
    if (menu.serviceDate !== serviceDate) {
      throw new Error(
        `${menu.itemName} is only on the menu for ${menu.serviceDate}, not ${serviceDate}`,
      );
    }
    return;
  }
  const dow = dayOfWeekForServiceDate(serviceDate);
  if (menu.dayOfWeek == null || menu.dayOfWeek !== dow) {
    throw new Error(
      `${menu.itemName} is a weekly ${WEEKDAY_SHORT[menu.dayOfWeek ?? 0]} plate — pick that weekday`,
    );
  }
}

function assertAdvanceServiceDate(serviceDate: string) {
  const today = serviceDateISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) {
    throw new Error("Pick a valid service date");
  }
  parseServiceDate(serviceDate);
  if (serviceDate < today) {
    throw new Error("Cannot order for a past date");
  }
  const max = addDaysISO(today, 7);
  if (serviceDate > max) {
    throw new Error("Advance orders are limited to the next 7 days");
  }
}

/** Next calendar day still before cut-off (for error copy). */
async function nextOpenServiceDateHint(
  db: Db,
  cook: { id: string; lunchCutoffHour?: number; lunchCutoffMinute?: number } & Record<
    string,
    unknown
  >,
  mealType: MealPeriod,
  fromServiceDate: string,
): Promise<string | null> {
  const schedule = await scheduleForCook(db, cook as never, mealType);
  for (let i = 1; i <= 7; i++) {
    const d = addDaysISO(fromServiceDate, i);
    if (isBeforeCutoff(mealType, new Date(), d, schedule.cutoff)) {
      return `${d} (order by ${formatCutoffLabel(schedule.cutoff)})`;
    }
  }
  return null;
}

async function ensureUser(
  db: Db,
  mobile: string,
  pinCode: string,
  address = "Address on file",
) {
  let user = await db.query.users.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, mobile),
  });
  if (!user) {
    const [created] = await db
      .insert(users)
      .values({
        mobileNumber: mobile,
        fullName: "Guest",
        primaryAddress: address,
        pinCode,
        segment: "BACHELOR",
      })
      .returning();
    user = created;
  }

  let home = await db.query.addresses.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.userMobile, mobile), e(t.label, "HOME")),
  });
  if (!home) {
    const [createdAddr] = await db
      .insert(addresses)
      .values({
        userMobile: mobile,
        label: "HOME",
        line1: user.primaryAddress,
        pinCode: user.pinCode ?? pinCode,
        isDefault: true,
      })
      .returning();
    home = createdAddr;
  }
  return { user, address: home };
}

/**
 * Web delivery must pick a saved address each checkout.
 * Pickup uses landmark text; WhatsApp without addressId falls back to HOME.
 */
async function resolveCheckoutAddress(
  db: Db,
  input: {
    customerMobile: string;
    cookPin: string;
    fulfillmentMode: FulfillmentMode;
    pickupLandmark?: string | null;
    addressId?: number | null;
    channel?: "WEB_STOREFRONT" | "WHATSAPP_BOT";
  },
) {
  const { user, address: home } = await ensureUser(db, input.customerMobile, input.cookPin);
  if (input.fulfillmentMode === "PICKUP") {
    return {
      user,
      address: home,
      deliveryTargetAddress: input.pickupLandmark
        ? `Pickup · ${input.pickupLandmark}`
        : "Pickup",
    };
  }

  if (input.addressId != null) {
    const { getAddressForUser } = await import("./addresses.js");
    const address = await getAddressForUser(db, input.customerMobile, input.addressId);
    const line1 = (address.line1 ?? "").trim();
    if (!line1 || /^address on file/i.test(line1)) {
      throw new Error("Choose a real delivery address (update Home/Office in My account)");
    }
    const line = address.line2 ? `${line1}, ${address.line2}` : line1;
    return {
      user,
      address,
      deliveryTargetAddress:
        input.fulfillmentMode === "CUSTOMER_ARRANGE" ? `Customer arranges · ${line}` : line,
    };
  }

  if (input.channel === "WHATSAPP_BOT") {
    const line = (home.line1 ?? "").trim();
    if (!line || /^address on file/i.test(line)) {
      throw new Error(
        "Save your delivery address first — reply: Address Tower/flat/street PIN 600119",
      );
    }
    return {
      user,
      address: home,
      deliveryTargetAddress: line,
    };
  }

  throw new Error("Choose a delivery address");
}

async function assertCapacity(db: Db, cookId: string, serviceDate: string, addQty: number) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, cookId),
  });
  if (!cook) return;
  const rows = await db.query.orders.findMany({
    where: (t, { eq: e, and: a, inArray: ia }) =>
      a(
        e(t.cookId, cookId),
        e(t.serviceDate, serviceDate),
        ia(t.status, [
          "PENDING_APPROVAL",
          "PAID",
          "COOKING",
          "PACKED",
          "DISPATCHED",
          "AWAITING_PAYMENT",
        ]),
      ),
  });
  const used = rows.reduce((n, o) => n + o.qty, 0);
  if (used + addQty > cook.maxDailyCapacity) {
    throw new Error(
      `Kitchen at capacity (${cook.maxDailyCapacity} plates) — try another kitchen or tomorrow`,
    );
  }
}

export async function createOrder(
  db: Db,
  input: {
    customerMobile: string;
    cookSlug: string;
    menuItemId: number;
    qty: number;
    spice: "NORMAL" | "LESS";
    channel?: "WEB_STOREFRONT" | "WHATSAPP_BOT";
    /** Calendar day for lunch (defaults to menu date or today). */
    serviceDate?: string;
    /** Skip cut-off check (late path after cook accepts). */
    allowAfterCutoff?: boolean;
    fulfillmentMode?: FulfillmentMode;
    /** Child Pays — ACTIVE family link required. */
    payerMobile?: string | null;
    /** Required for web delivery — saved address id. */
    addressId?: number | null;
    /** Optional HTTP Idempotency-Key (preferred over business-derived key). */
    clientIdempotencyKey?: string | null;
  },
) {
  const { assertFeatureEnabled } = await import("./featureFlags.js");
  await assertFeatureEnabled(
    db,
    "ordering_enabled",
    "Ordering is temporarily paused — try again later",
  );
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, input.cookSlug),
  });
  if (!cook) throw new Error("Kitchen not found");
  assertCanAcceptPaidOrders({
    onboardingStatus: cook.onboardingStatus,
    fssaiNumber: cook.fssaiNumber,
    isActive: cook.isActive,
    payoutUpiId: cook.payoutUpiId,
    payoutAccountNote: cook.payoutAccountNote,
    payoutBeneficiaryRef: cook.payoutBeneficiaryRef,
  });

  let payerMobile: string | null = null;
  if (input.payerMobile?.trim()) {
    await assertFeatureEnabled(
      db,
      "child_pays_enabled",
      "Child Pays is temporarily off — pay with this phone instead",
    );
    const { assertActiveFamilyLink, normalizeFamilyMobile } = await import("./family.js");
    payerMobile = normalizeFamilyMobile(input.payerMobile);
    await assertActiveFamilyLink(db, input.customerMobile, payerMobile);
  }

  const menu = await db.query.dailyMenus.findFirst({
    where: (t, { eq: e }) => e(t.id, input.menuItemId),
  });
  if (!menu || menu.cookId !== cook.id) throw new Error("Menu item not found");
  if (!menu.isAvailable) throw new Error("That plate is not available");

  const serviceDate = input.serviceDate ?? menu.serviceDate ?? serviceDateISO();
  assertIntakeOpen(cook.intakePausedDate, serviceDate);
  assertAdvanceServiceDate(serviceDate);
  assertMenuAppliesToDate(menu, serviceDate);

  const { fulfillmentMode, pickupLandmark, deliveryPaise: fulfillDeliveryPaise } =
    await resolveCheckoutFulfillment(db, cook, input.fulfillmentMode);

  const mealType = (menu.mealType ?? "LUNCH") as MealPeriod;
  const schedule = await scheduleForCook(db, cook, mealType);
  if (!schedule.enabled) {
    throw new Error(`${mealLabel(mealType)} is not offered by this kitchen`);
  }
  if (
    !input.allowAfterCutoff &&
    !isBeforeCutoff(mealType, new Date(), serviceDate, schedule.cutoff)
  ) {
    const nextHint = await nextOpenServiceDateHint(db, cook, mealType, serviceDate);
    throw new Error(
      `${mealLabel(mealType)} cut-off passed (${formatCutoffLabel(schedule.cutoff)})` +
        (nextHint ? ` — try ${nextHint}` : " — use late availability flow"),
    );
  }

  const channel = input.channel ?? "WEB_STOREFRONT";
  const { address, deliveryTargetAddress } = await resolveCheckoutAddress(db, {
    customerMobile: input.customerMobile,
    cookPin: cook.pinCode,
    fulfillmentMode,
    pickupLandmark,
    addressId: input.addressId,
    channel,
  });
  await assertCapacity(db, cook.id, serviceDate, input.qty);

  const deliveryPaise = await applyDeliveryDistancePaise(db, {
    cook,
    address,
    fulfillmentMode,
    baseDeliveryPaise: fulfillDeliveryPaise,
  });
  const feePaise = platformFeePaise();
  const amountPaise = orderTotalPaise({
    foodPaise: menu.pricePaise,
    deliveryPaise,
    platformFeePaise: feePaise,
    qty: input.qty,
  });
  const idempotencyKey = input.clientIdempotencyKey?.trim()
    ? httpIdempotencyKey(input.customerMobile, input.clientIdempotencyKey)
    : buildIdempotencyKey({
        customerMobile: input.customerMobile,
        cookId: cook.id,
        mealType,
        serviceDate,
        amountPaise,
        menuItemId: menu.id,
        spice: input.spice,
        late: Boolean(input.allowAfterCutoff),
        fulfillmentMode,
      });

  let orderIdempotencyKey = idempotencyKey;
  const existing = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.idempotencyKey, orderIdempotencyKey),
  });
  if (existing) {
    const reopen =
      existing.status === "AWAITING_PAYMENT" || existing.status === "PENDING_APPROVAL";
    if (reopen) {
      bindTrace({
        traceId: existing.traceId,
        publicId: existing.publicId,
        checkoutId: existing.checkoutId,
        customerMobile: existing.customerMobile,
        cookId: existing.cookId,
        orderId: existing.id,
        status: existing.status,
        amountPaise: lineTotal(existing),
        mealType: existing.mealType,
        serviceDate: existing.serviceDate,
      });
      return {
        ...existing,
        paymentUrl: await resolveCustomerPaymentUrl(db, {
          orderId: existing.id,
          publicId: existing.publicId,
          gatewayTxnId: existing.gatewayTxnId,
          checkoutId: existing.checkoutId,
        }),
        gatewayTxnId: existing.gatewayTxnId,
      };
    }
    // Same deterministic key but order already progressed — allow an additional order.
    orderIdempotencyKey = `${orderIdempotencyKey}|addl|${publicId()}`;
  }

  const pay = getPaymentProvider();
  const billMobile = payerMobile ?? input.customerMobile;

  return db.transaction(async (tx) => {
    const pid = publicId();
    const traceId = newTraceId();
    bindTrace({
      traceId,
      publicId: pid,
      customerMobile: input.customerMobile,
      cookSlug: cook.slugHandle,
      cookId: cook.id,
      status: "AWAITING_PAYMENT",
      amountPaise,
      mealType,
      serviceDate,
    });
    const [order] = await tx
      .insert(orders)
      .values({
        publicId: pid,
        traceId,
        customerMobile: input.customerMobile,
        payerMobile,
        cookId: cook.id,
        menuItemId: menu.id,
        addressId: address.id,
        mealType,
        serviceDate,
        itemName: menu.itemName,
        itemNameTa: menu.itemNameTa ?? null,
        qty: input.qty,
        spice: input.spice,
        foodPaise: menu.pricePaise,
        deliveryPaise,
        platformFeePaise: feePaise,
        status: "AWAITING_PAYMENT",
        fulfillmentMode,
        deliveryTargetAddress,
        channel,
        idempotencyKey: orderIdempotencyKey,
      })
      .returning();

    orderLog.info(
      {
        event: LogEvent.THIRD_PARTY_REQUEST,
        provider: "payment",
        action: "createPayment",
        ...orderTriageFields({
          traceId,
          publicId: order.publicId,
          orderId: order.id,
          customerMobile: input.customerMobile,
          cookSlug: cook.slugHandle,
          cookId: cook.id,
          amountPaise,
          mealType,
          serviceDate,
          status: "AWAITING_PAYMENT",
          channel,
        }),
      },
      "payment createPayment",
    );
    const payment = await pay.createPayment({
      orderPublicId: order.publicId,
      amountPaise,
      customerMobile: billMobile,
      idempotencyKey: orderIdempotencyKey,
      traceId,
    });

    await tx.insert(payments).values({
      orderId: order.id,
      kind: "CHARGE",
      amountPaise,
      status: "CREATED",
      gatewayTxnId: payment.gatewayTxnId,
      idempotencyKey: orderIdempotencyKey,
    });

    const [updated] = await tx
      .update(orders)
      .set({ gatewayTxnId: payment.gatewayTxnId, updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();

    await tx.insert(platformEventLedger).values({
      associatedMobile: input.customerMobile,
      orderId: order.id,
      cookId: cook.id,
      channel,
      eventName: "ORDER_CREATED",
      rawPayload: {
        paymentUrl: payment.paymentUrl,
        late: Boolean(input.allowAfterCutoff),
        childPays: Boolean(payerMobile),
        traceId,
      },
    });

    await enqueueOutbox(tx, "OrderCreated", {
        orderId: order.id,
        publicId: order.publicId,
        traceId,
        checkoutId: null,
        cookId: cook.id,
        cookSlug: cook.slugHandle,
        kitchenName: cook.kitchenName,
        customerMobile: input.customerMobile,
        payerMobile,
        billMobile,
        childPays: Boolean(payerMobile),
        itemName: menu.itemName,
        qty: input.qty,
        spice: input.spice,
        serviceDate,
        mealType,
        amountPaise,
        paymentUrl: payment.paymentUrl,
        gatewayTxnId: payment.gatewayTxnId,
      });

    orderLog.info(
      {
        event: LogEvent.ORDER_CREATED,
        ...orderTriageFields({
          traceId,
          publicId: order.publicId,
          orderId: order.id,
          customerMobile: input.customerMobile,
          cookSlug: cook.slugHandle,
          cookId: cook.id,
          kitchenName: cook.kitchenName,
          status: order.status,
          amountPaise,
          mealType,
          serviceDate,
          itemName: menu.itemName,
          qty: input.qty,
          fulfillmentMode,
          channel,
        }),
      },
      "order created",
    );

    if (payerMobile) {
      await enqueueOutbox(tx, "ChildPaysRequested", {
          checkoutId: null,
          orderPublicId: order.publicId,
          payerMobile,
          seniorMobile: input.customerMobile,
          kitchenName: cook.kitchenName,
          paymentUrl: payment.paymentUrl,
          amountPaise,
          lineCount: 1,
        });
      const { recordOrderActivity } = await import("./orderActivity.js");
      await recordOrderActivity(tx, {
        orderId: order.id,
        customerMobile: input.customerMobile,
        cookId: cook.id,
        channel,
        eventName: "CHILD_PAYS_REQUESTED",
        payload: { payerMobile, publicId: order.publicId },
      });
    }

    return {
      ...updated,
      paymentUrl: payment.paymentUrl,
      gatewayTxnId: payment.gatewayTxnId,
    };
  });
}

export async function markOrderPaid(
  db: Db,
  input: {
    gatewayTxnId?: string;
    orderPublicId?: string;
    paymentId?: string;
    /** When set (webhook / confirm-return), must match order charge total. */
    paidAmountPaise?: number;
    rawPayload?: unknown;
  },
) {
  let group: (typeof orders.$inferSelect)[] = [];
  if (input.gatewayTxnId) {
    group = await db.query.orders.findMany({
      where: (t, { eq: e }) => e(t.gatewayTxnId, input.gatewayTxnId!),
    });
  }
  if (!group.length && input.orderPublicId) {
    if (input.orderPublicId.startsWith("CHK-")) {
      group = await db.query.orders.findMany({
        where: (t, { eq: e }) => e(t.checkoutId, input.orderPublicId!),
      });
    } else {
      const one = await db.query.orders.findFirst({
        where: (t, { eq: e }) => e(t.publicId, input.orderPublicId!),
      });
      if (one?.checkoutId) {
        group = await db.query.orders.findMany({
          where: (t, { eq: e }) => e(t.checkoutId, one.checkoutId!),
        });
      } else if (one) {
        group = [one];
      }
    }
  }
  if (!group.length) throw new Error("Order not found for txn");

  bindTrace({
    traceId: group[0].traceId,
    publicId: group[0].publicId,
    checkoutId: group[0].checkoutId,
    customerMobile: group[0].customerMobile,
    cookId: group[0].cookId,
    orderId: group[0].id,
    status: group[0].status,
    amountPaise: lineTotal(group[0]),
    mealType: group[0].mealType,
    serviceDate: group[0].serviceDate,
  });

  // Idempotent: if every line already paid (or past), return first
  if (group.every((o) => ALREADY_PAID.includes(o.status as OrderState))) {
    return {
      ...group[0],
      orders: group,
      checkoutId: group[0].checkoutId,
    };
  }

  const expectedPaise = group.reduce((s, o) => s + lineTotal(o), 0);
  if (
    typeof input.paidAmountPaise === "number" &&
    input.paidAmountPaise > 0 &&
    input.paidAmountPaise !== expectedPaise
  ) {
    throw new Error("Payment amount does not match order");
  }

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, group[0].cookId),
  });

  const checkoutSorted = [...group].sort(
    (a, b) => a.serviceDate.localeCompare(b.serviceDate) || a.id - b.id,
  );
  const checkoutDayCount = checkoutSorted.length;

  const updatedRows = await db.transaction(async (tx) => {
    const out = [];
    for (const order of group) {
      if (ALREADY_PAID.includes(order.status as OrderState)) {
        out.push(order);
        continue;
      }
      // UPI may have marked FAILED on an abandoned attempt before capture —
      // allow gateway-confirmed recovery without a formal FAILED→PAID edge.
      if (order.status === "FAILED") {
        /* recovery from false failure */
      } else {
        assertTransition(order.status as OrderState, "PAID");
      }

      const deliveryWindow = cook
        ? formatDeliveryWindowLabel(
            (await scheduleForCook(db, cook, order.mealType as MealPeriod)).deliveryWindow,
          )
        : null;

      let [updated] = await tx
        .update(orders)
        .set({ status: "PAID", updatedAt: new Date() })
        .where(eq(orders.id, order.id))
        .returning();

      await tx
        .update(payments)
        .set({
          status: "CAPTURED",
          rawPayload: {
            ...(typeof input.rawPayload === "object" && input.rawPayload
              ? (input.rawPayload as object)
              : {}),
            razorpayPaymentId: input.paymentId ?? null,
            paymentLinkId: input.gatewayTxnId,
          },
        })
        .where(eq(payments.orderId, order.id));

      const checkoutDayOrdinal =
        checkoutSorted.findIndex((o) => o.id === order.id) + 1;

      await enqueueOutbox(tx, "OrderPaid", {
          orderId: order.id,
          publicId: order.publicId,
          traceId: order.traceId,
          checkoutId: order.checkoutId,
          cookId: order.cookId,
          cookMobile: cook?.mobileNumber ?? null,
          cookSlug: cook?.slugHandle ?? null,
          itemName: order.itemName,
          qty: order.qty,
          spice: order.spice,
          mealType: order.mealType,
          serviceDate: order.serviceDate,
          /** Week cart: one outbox row per day; cook WA shows day N of M. */
          checkoutDayCount,
          checkoutDayOrdinal,
          deliveryTargetAddress: order.deliveryTargetAddress,
          customerMobile: order.customerMobile,
          deliveryWindow,
          paymentId: input.paymentId ?? null,
        });

      await tx.insert(platformEventLedger).values({
        associatedMobile: order.customerMobile,
        orderId: order.id,
        cookId: order.cookId,
        channel: order.channel,
        eventName: "ORDER_PAID",
        rawPayload: input.rawPayload as object,
      });

      const lock = await tx.query.cutoffLocks.findFirst({
        where: (t, { eq: e, and: a }) =>
          a(
            e(t.cookId, order.cookId),
            e(t.serviceDate, order.serviceDate),
            e(t.mealType, order.mealType),
          ),
      });
      if (lock) {
        assertTransition("PAID", "COOKING");
        [updated] = await tx
          .update(orders)
          .set({ status: "COOKING", updatedAt: new Date() })
          .where(eq(orders.id, order.id))
          .returning();
        const { recordOrderActivity } = await import("./orderActivity.js");
        await recordOrderActivity(tx, {
          orderId: order.id,
          customerMobile: order.customerMobile,
          cookId: order.cookId,
          channel: "SYSTEM_CRON",
          eventName: "ORDER_STATUS_COOKING",
          payload: {
            fromStatus: "PAID",
            toStatus: "COOKING",
            reason: "cutoff_lock",
            serviceDate: order.serviceDate,
            mealType: order.mealType,
            publicId: order.publicId,
          },
        });
      }
      out.push(updated);
      orderLog.info(
        {
          event: LogEvent.ORDER_PAID,
          ...orderTriageFields({
            traceId: order.traceId,
            publicId: order.publicId,
            checkoutId: order.checkoutId,
            orderId: order.id,
            customerMobile: order.customerMobile,
            cookSlug: cook?.slugHandle,
            cookId: order.cookId,
            kitchenName: cook?.kitchenName,
            status: updated.status,
            amountPaise: lineTotal(order),
            mealType: order.mealType,
            serviceDate: order.serviceDate,
            itemName: order.itemName,
            qty: order.qty,
            fulfillmentMode: order.fulfillmentMode,
            channel: order.channel,
          }),
          paymentId: input.paymentId ?? null,
          gatewayTxnId: input.gatewayTxnId ?? order.gatewayTxnId,
        },
        "order paid",
      );
    }
    return out;
  });

  return {
    ...updatedRows[0],
    orders: updatedRows,
    checkoutId: updatedRows[0]?.checkoutId ?? group[0].checkoutId,
  };
}

/** Multi-day (or multi-plate) cart: one payment, one row per service day. */
export async function createOrderBatch(
  db: Db,
  input: {
    customerMobile: string;
    cookSlug: string;
    channel?: "WEB_STOREFRONT" | "WHATSAPP_BOT";
    /** Child-Pays: active family payer who settles UPI. */
    payerMobile?: string | null;
    fulfillmentMode?: FulfillmentMode;
    /** Required for web delivery — saved address id. */
    addressId?: number | null;
    /** Optional HTTP Idempotency-Key for the whole cart payment. */
    clientIdempotencyKey?: string | null;
    lines: Array<{
      menuItemId: number;
      serviceDate: string;
      qty: number;
      spice: "NORMAL" | "LESS";
    }>;
  },
) {
  if (!input.lines.length) throw new Error("Add at least one day to the cart");
  // Up to 14 calendar days × breakfast/lunch/dinner.
  if (input.lines.length > 42) throw new Error("Cart is limited to 42 plates");
  if (new Set(input.lines.map((l) => l.serviceDate)).size > 14) {
    throw new Error("Cart is limited to 14 days");
  }

  const { assertFeatureEnabled, getFeatureFlags } = await import("./featureFlags.js");
  await assertFeatureEnabled(
    db,
    "ordering_enabled",
    "Ordering is temporarily paused — try again later",
  );

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, input.cookSlug),
  });
  if (!cook) throw new Error("Kitchen not found");
  assertCanAcceptPaidOrders({
    onboardingStatus: cook.onboardingStatus,
    fssaiNumber: cook.fssaiNumber,
    isActive: cook.isActive,
    payoutUpiId: cook.payoutUpiId,
    payoutAccountNote: cook.payoutAccountNote,
    payoutBeneficiaryRef: cook.payoutBeneficiaryRef,
  });

  for (const line of input.lines) {
    assertIntakeOpen(cook.intakePausedDate, line.serviceDate);
  }

  const { fulfillmentMode, pickupLandmark, deliveryPaise: fulfillDeliveryPaise } =
    await resolveCheckoutFulfillment(db, cook, input.fulfillmentMode);

  const channel = input.channel ?? "WEB_STOREFRONT";
  let payerMobile: string | null = null;
  if (input.payerMobile?.trim()) {
    await assertFeatureEnabled(
      db,
      "child_pays_enabled",
      "Child Pays is temporarily off — pay with this phone instead",
    );
    const { assertActiveFamilyLink, normalizeFamilyMobile } = await import("./family.js");
    payerMobile = normalizeFamilyMobile(input.payerMobile);
    await assertActiveFamilyLink(db, input.customerMobile, payerMobile);
  }

  // Replay prior cart create when the client sends the same Idempotency-Key.
  if (input.clientIdempotencyKey?.trim()) {
    const hdrKey = httpIdempotencyKey(input.customerMobile, input.clientIdempotencyKey);
    const priorPay = await db.query.payments.findFirst({
      where: (t, { eq: e }) => e(t.idempotencyKey, hdrKey),
    });
    if (priorPay) {
      const first = await db.query.orders.findFirst({
        where: (t, { eq: e }) => e(t.id, priorPay.orderId),
      });
      if (first?.checkoutId) {
        const existingLines = await db.query.orders.findMany({
          where: (t, { eq: e }) => e(t.checkoutId, first.checkoutId!),
        });
        if (existingLines.length) {
          const totalPaise = existingLines.reduce((s, o) => s + lineTotal(o), 0);
          bindTrace({
            traceId: first.traceId,
            publicId: first.publicId,
            checkoutId: first.checkoutId,
          });
          return {
            checkoutId: first.checkoutId,
            traceId: first.traceId,
            gatewayTxnId: first.gatewayTxnId,
            paymentUrl: await resolveCustomerPaymentUrl(db, {
              orderId: first.id,
              publicId: first.publicId,
              gatewayTxnId: first.gatewayTxnId,
              checkoutId: first.checkoutId,
            }),
            totalPaise,
            foodDiscountTotalPaise: existingLines.reduce(
              (s, o) => s + (o.foodDiscountPaise ?? 0),
              0,
            ),
            weekDiscountPercent: existingLines[0]?.weekDiscountPercent ?? null,
            status: first.status as "AWAITING_PAYMENT",
            orders: existingLines,
          };
        }
      }
    }
  }

  const flags = await getFeatureFlags(db);
  const { address, deliveryTargetAddress: targetAddress } = await resolveCheckoutAddress(db, {
    customerMobile: input.customerMobile,
    cookPin: cook.pinCode,
    fulfillmentMode,
    pickupLandmark,
    addressId: input.addressId,
    channel,
  });
  const deliveryPaise = await applyDeliveryDistancePaise(db, {
    cook,
    address,
    fulfillmentMode,
    baseDeliveryPaise: fulfillDeliveryPaise,
  });

  type Prepared = {
    menu: NonNullable<Awaited<ReturnType<typeof db.query.dailyMenus.findFirst>>>;
    serviceDate: string;
    mealType: MealPeriod;
    qty: number;
    spice: "NORMAL" | "LESS";
    foodDiscountPaise: number;
    weekDiscountPercent: number | null;
    platformFeePaise: number;
    amountPaise: number;
    idempotencyKey: string;
  };

  const drafts: Array<{
    menu: NonNullable<Awaited<ReturnType<typeof db.query.dailyMenus.findFirst>>>;
    serviceDate: string;
    mealType: MealPeriod;
    qty: number;
    spice: "NORMAL" | "LESS";
  }> = [];
  const qtyByDate = new Map<string, number>();

  for (const line of input.lines) {
    assertAdvanceServiceDate(line.serviceDate);
    const menu = await db.query.dailyMenus.findFirst({
      where: (t, { eq: e }) => e(t.id, line.menuItemId),
    });
    if (!menu || menu.cookId !== cook.id) {
      throw new Error(`Menu item ${line.menuItemId} not found for this kitchen`);
    }
    if (!menu.isAvailable) throw new Error(`${menu.itemName} is not available`);
    assertMenuAppliesToDate(menu, line.serviceDate);

    const mealType = (menu.mealType ?? "LUNCH") as MealPeriod;
    const schedule = await scheduleForCook(db, cook, mealType);
    if (!schedule.enabled) {
      throw new Error(`${mealLabel(mealType)} is not offered by this kitchen`);
    }
    if (!isBeforeCutoff(mealType, new Date(), line.serviceDate, schedule.cutoff)) {
      const nextHint = await nextOpenServiceDateHint(db, cook, mealType, line.serviceDate);
      throw new Error(
        `${mealLabel(mealType)} on ${line.serviceDate}: cut-off passed (${formatCutoffLabel(schedule.cutoff)})` +
          (nextHint
            ? ` — try ${nextHint}, or remove that day / order late`
            : " — remove that day or order late separately"),
      );
    }

    drafts.push({
      menu,
      serviceDate: line.serviceDate,
      mealType,
      qty: line.qty,
      spice: line.spice,
    });
    qtyByDate.set(line.serviceDate, (qtyByDate.get(line.serviceDate) ?? 0) + line.qty);
  }

  // Same calendar day + meal twice → reject (B+L+D same day is OK)
  const slots = drafts.map((p) => `${p.serviceDate}|${p.mealType}`);
  if (new Set(slots).size !== slots.length) {
    throw new Error("Only one plate per meal on each day — remove the duplicate");
  }

  for (const [serviceDate, qty] of qtyByDate) {
    await assertCapacity(db, cook.id, serviceDate, qty);
  }

  const weekRule = normalizeWeekDiscountRule({
    percent: flags.week_discount_enabled ? cook.weekDiscountPercent : 0,
    minDays: cook.weekDiscountMinDays,
  });
  // Week % is by calendar days, not meal lines (B+L+D same day = 1 day).
  const dayCount = new Set(drafts.map((d) => d.serviceDate)).size;
  const discountOn = weekDiscountApplies(dayCount, weekRule);

  const mealOrder: Record<string, number> = { BREAKFAST: 0, LUNCH: 1, DINNER: 2 };
  // Earliest day gets the single ₹7 platform fee for this checkout; delivery stays per meal line.
  const draftsByDate = [...drafts].sort((a, b) => {
    const byDate = a.serviceDate.localeCompare(b.serviceDate);
    if (byDate !== 0) return byDate;
    return (mealOrder[a.mealType] ?? 9) - (mealOrder[b.mealType] ?? 9);
  });

  const prepared: Prepared[] = draftsByDate.map((d, lineIndex) => {
    const linePlatformFeePaise = platformFeePaiseForCheckoutLine(lineIndex);
    const foodDiscountPaise = lineFoodDiscountPaise({
      foodPaise: d.menu.pricePaise,
      qty: d.qty,
      dayCount,
      rule: weekRule,
    });
    const amountPaise = orderTotalPaise({
      foodPaise: d.menu.pricePaise,
      deliveryPaise,
      platformFeePaise: linePlatformFeePaise,
      qty: d.qty,
      foodDiscountPaise,
    });
    return {
      ...d,
      foodDiscountPaise,
      weekDiscountPercent: discountOn ? weekRule.percent : null,
      platformFeePaise: linePlatformFeePaise,
      amountPaise,
      idempotencyKey: buildIdempotencyKey({
        customerMobile: input.customerMobile,
        cookId: cook.id,
        mealType: d.mealType,
        serviceDate: d.serviceDate,
        amountPaise,
        menuItemId: d.menu.id,
        spice: d.spice,
        fulfillmentMode,
      }),
    };
  });

  const checkoutId = checkoutPublicId();
  const traceId = newTraceId();
  bindTrace({
    traceId,
    checkoutId,
    customerMobile: input.customerMobile,
    cookSlug: cook.slugHandle,
    cookId: cook.id,
    status: "AWAITING_PAYMENT",
    amountPaise: prepared.reduce((s, p) => s + p.amountPaise, 0),
    mealType: prepared[0]?.mealType,
  });
  const totalPaise = prepared.reduce((s, p) => s + p.amountPaise, 0);
  const foodDiscountTotalPaise = prepared.reduce((s, p) => s + p.foodDiscountPaise, 0);
  const batchIdempotency = input.clientIdempotencyKey?.trim()
    ? httpIdempotencyKey(input.customerMobile, input.clientIdempotencyKey)
    : `batch|${createHash("sha256")
        .update(
          [input.customerMobile, cook.id, ...prepared.map((p) => p.idempotencyKey).sort()].join(
            "|",
          ),
        )
        .digest("hex")
        .slice(0, 40)}`;

  // Salt line keys with this checkout attempt so a 2nd same-day order is allowed.
  // Same Idempotency-Key header still replays an in-flight unpaid checkout below.
  const lineKeySalt = batchIdempotency.slice(0, 24);
  for (const p of prepared) {
    p.idempotencyKey = `${p.idempotencyKey}|${lineKeySalt}`;
  }

  // Idempotency: replay unpaid checkout when the same client key is retried.
  const existingByKey = new Map<string, NonNullable<Awaited<ReturnType<typeof db.query.orders.findFirst>>>>();
  for (const p of prepared) {
    const existing = await db.query.orders.findFirst({
      where: (t, { eq: e }) => e(t.idempotencyKey, p.idempotencyKey),
    });
    if (existing) existingByKey.set(p.idempotencyKey, existing);
  }

  const existingLines = [...existingByKey.values()];
  if (existingLines.length === prepared.length) {
    const allAwaiting = existingLines.every((o) => o.status === "AWAITING_PAYMENT");
    const sameCheckout =
      existingLines[0].checkoutId != null &&
      existingLines.every((o) => o.checkoutId === existingLines[0].checkoutId);
    if (allAwaiting && (sameCheckout || prepared.length === 1)) {
      const first = existingLines[0];
      const existingCheckoutId = first.checkoutId ?? first.publicId;
      const gatewayTxnId = first.gatewayTxnId;
      const existingTotal = existingLines.reduce((s, o) => s + lineTotal(o), 0);
      bindTrace({
        traceId: first.traceId,
        publicId: first.publicId,
        checkoutId: first.checkoutId ?? existingCheckoutId,
      });
      return {
        checkoutId: existingCheckoutId,
        traceId: first.traceId,
        gatewayTxnId,
        paymentUrl: await resolveCustomerPaymentUrl(db, {
          orderId: first.id,
          publicId: first.publicId,
          gatewayTxnId,
          checkoutId: first.checkoutId ?? existingCheckoutId,
        }),
        totalPaise: existingTotal,
        foodDiscountTotalPaise: existingLines.reduce(
          (s, o) => s + (o.foodDiscountPaise ?? 0),
          0,
        ),
        weekDiscountPercent: existingLines[0]?.weekDiscountPercent ?? null,
        status: "AWAITING_PAYMENT" as const,
        orders: existingLines,
      };
    }
  }

  // Abandoned unpaid lines from earlier attempts with these salted keys
  for (const o of existingLines) {
    if (o.status === "AWAITING_PAYMENT") {
      await db
        .update(orders)
        .set({
          status: "CANCELLED",
          updatedAt: new Date(),
          idempotencyKey: null,
          gatewayTxnId: null,
        })
        .where(eq(orders.id, o.id));
    }
  }

  const pay = getPaymentProvider();

  return db.transaction(async (tx) => {
    const created = [];
    for (const p of prepared) {
      const pid = publicId();
      const [order] = await tx
        .insert(orders)
        .values({
          publicId: pid,
          traceId,
          customerMobile: input.customerMobile,
          payerMobile,
          cookId: cook.id,
          menuItemId: p.menu.id,
          addressId: address.id,
          mealType: p.mealType,
          serviceDate: p.serviceDate,
          itemName: p.menu.itemName,
          itemNameTa: p.menu.itemNameTa ?? null,
          qty: p.qty,
          spice: p.spice,
          foodPaise: p.menu.pricePaise,
          foodDiscountPaise: p.foodDiscountPaise,
          weekDiscountPercent: p.weekDiscountPercent,
          deliveryPaise,
          platformFeePaise: p.platformFeePaise,
          status: "AWAITING_PAYMENT",
          fulfillmentMode,
          deliveryTargetAddress: targetAddress,
          channel,
          checkoutId,
          idempotencyKey: p.idempotencyKey,
        })
        .returning();
      created.push(order);
    }

    const billMobile = payerMobile ?? input.customerMobile;
    orderLog.info(
      {
        event: LogEvent.THIRD_PARTY_REQUEST,
        provider: "payment",
        action: "createPayment",
        ...orderTriageFields({
          traceId,
          checkoutId,
          customerMobile: input.customerMobile,
          cookSlug: cook.slugHandle,
          cookId: cook.id,
          amountPaise: totalPaise,
          mealType: created[0]?.mealType,
          status: "AWAITING_PAYMENT",
          channel,
          fulfillmentMode,
        }),
        lineCount: created.length,
      },
      "payment createPayment (checkout)",
    );
    const payment = await pay.createPayment({
      orderPublicId: checkoutId,
      amountPaise: totalPaise,
      customerMobile: billMobile,
      idempotencyKey: batchIdempotency,
      traceId,
    });

    // One payment row on the first order for the full cart total; lines share gatewayTxnId
    await tx.insert(payments).values({
      orderId: created[0].id,
      kind: "CHARGE",
      amountPaise: totalPaise,
      status: "CREATED",
      gatewayTxnId: payment.gatewayTxnId,
      idempotencyKey: batchIdempotency,
    });

    for (const order of created) {
      await tx
        .update(orders)
        .set({ gatewayTxnId: payment.gatewayTxnId, updatedAt: new Date() })
        .where(eq(orders.id, order.id));
    }

    await tx.insert(platformEventLedger).values({
      associatedMobile: input.customerMobile,
      orderId: created[0].id,
      cookId: cook.id,
      channel,
      eventName: "ORDER_CREATED",
      rawPayload: {
        checkoutId,
        traceId,
        paymentUrl: payment.paymentUrl,
        linePublicIds: created.map((o) => o.publicId),
        totalPaise,
      },
    });

    await enqueueOutbox(tx, "OrderCreated", {
        checkoutId,
        traceId,
        orderIds: created.map((o) => o.id),
        publicIds: created.map((o) => o.publicId),
        cookId: cook.id,
        cookSlug: cook.slugHandle,
        kitchenName: cook.kitchenName,
        customerMobile: input.customerMobile,
        payerMobile,
        billMobile,
        childPays: Boolean(payerMobile),
        paymentUrl: payment.paymentUrl,
        gatewayTxnId: payment.gatewayTxnId,
        amountPaise: totalPaise,
        lines: created.map((o) => ({
          publicId: o.publicId,
          itemName: o.itemName,
          qty: o.qty,
          serviceDate: o.serviceDate,
          spice: o.spice,
        })),
      });

    orderLog.info(
      {
        event: LogEvent.ORDER_CREATED,
        ...orderTriageFields({
          traceId,
          checkoutId,
          customerMobile: input.customerMobile,
          cookSlug: cook.slugHandle,
          cookId: cook.id,
          kitchenName: cook.kitchenName,
          status: "AWAITING_PAYMENT",
          amountPaise: totalPaise,
          mealType: created[0]?.mealType,
          fulfillmentMode,
          channel,
        }),
        publicIds: created.map((o) => o.publicId),
        lineCount: created.length,
        serviceDates: created.map((o) => o.serviceDate),
      },
      "checkout created",
    );

    if (payerMobile) {
      await enqueueOutbox(tx, "ChildPaysRequested", {
          checkoutId,
          payerMobile,
          seniorMobile: input.customerMobile,
          kitchenName: cook.kitchenName,
          paymentUrl: payment.paymentUrl,
          amountPaise: totalPaise,
          lineCount: created.length,
        });
      const { recordOrderActivity } = await import("./orderActivity.js");
      for (const o of created) {
        await recordOrderActivity(tx, {
          orderId: o.id,
          customerMobile: input.customerMobile,
          cookId: cook.id,
          channel,
          eventName: "CHILD_PAYS_REQUESTED",
          payload: { payerMobile, checkoutId, publicId: o.publicId },
        });
      }
    }

    const refreshed = await tx.query.orders.findMany({
      where: (t, { eq: e }) => e(t.checkoutId, checkoutId),
    });

    return {
      checkoutId,
      traceId,
      gatewayTxnId: payment.gatewayTxnId,
      paymentUrl: payment.paymentUrl,
      totalPaise,
      foodDiscountTotalPaise,
      weekDiscountPercent: discountOn ? weekRule.percent : null,
      status: "AWAITING_PAYMENT" as const,
      orders: refreshed,
    };
  });
}

export async function getCheckoutById(db: Db, checkoutId: string) {
  const rows = await db.query.orders.findMany({
    where: (t, { eq: e }) => e(t.checkoutId, checkoutId),
    orderBy: (t, { asc }) => [asc(t.serviceDate)],
  });
  if (!rows.length) return null;
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, rows[0].cookId),
  });
  const totalPaise = rows.reduce((s, o) => s + lineTotal(o), 0);
  const withFlags = [];
  for (const o of rows) {
    withFlags.push({
      ...o,
      lineTotalPaise: lineTotal(o),
      cancellable: await isOrderCancellable(db, o, cook),
      cancelRequestable: await isOrderCancelRequestable(db, o, cook),
    });
  }
  return {
    checkoutId,
    status: aggregateCheckoutStatus(rows.map((o) => o.status)),
    gatewayTxnId: rows[0].gatewayTxnId,
    payerMobile: rows[0].payerMobile ?? null,
    customerMobile: rows[0].customerMobile,
    paymentUrl: await resolveCustomerPaymentUrl(db, {
      orderId: rows[0].id,
      publicId: rows[0].publicId,
      gatewayTxnId: rows[0].gatewayTxnId,
      checkoutId,
    }),
    totalPaise,
    kitchenName: cook?.kitchenName ?? null,
    cookSlug: cook?.slugHandle ?? null,
    cancellable: withFlags.some((o) => o.cancellable),
    cancelRequestable: withFlags.some((o) => o.cancelRequestable),
    orders: withFlags,
  };
}

/** Unpaid / late-pending: cancel anytime. Paid: only before cut-off without cook. */
async function assertCustomerCanCancelInstant(
  db: Db,
  order: typeof orders.$inferSelect,
  cook: { id: string },
) {
  if (order.status === "PENDING_APPROVAL" || order.status === "AWAITING_PAYMENT") {
    assertTransition(order.status as OrderState, "CANCELLED");
    return;
  }
  if (order.status !== "PAID") {
    throw new Error("This order can’t be cancelled anymore");
  }
  const schedule = await scheduleForCook(db, cook, order.mealType as MealPeriod);
  if (!isBeforeCutoff(order.mealType as MealPeriod, new Date(), order.serviceDate, schedule.cutoff)) {
    throw new Error(
      `Cannot cancel after ${mealLabel(order.mealType as MealPeriod)} cut-off (${formatCutoffLabel(schedule.cutoff)}) — ask the kitchen (Request cancel) or contact support`,
    );
  }
  assertTransition(order.status as OrderState, "CANCELLED");
}

export async function isOrderCancellable(
  db: Db,
  order: {
    status: string;
    mealType: string;
    serviceDate: string;
    cookId: string;
  },
  cook?: { id: string } | null,
): Promise<boolean> {
  if (order.status === "PENDING_APPROVAL" || order.status === "AWAITING_PAYMENT") {
    return true;
  }
  if (order.status !== "PAID") return false;
  const profile =
    cook ??
    (await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.id, order.cookId),
    }));
  if (!profile) return false;
  const schedule = await scheduleForCook(db, profile, order.mealType as MealPeriod);
  return isBeforeCutoff(
    order.mealType as MealPeriod,
    new Date(),
    order.serviceDate,
    schedule.cutoff,
  );
}

/** Paid + past cut-off → customer may ask kitchen to cancel (not instant). */
export async function isOrderCancelRequestable(
  db: Db,
  order: {
    status: string;
    mealType: string;
    serviceDate: string;
    cookId: string;
  },
  cook?: { id: string } | null,
): Promise<boolean> {
  if (order.status !== "PAID") return false;
  const profile =
    cook ??
    (await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.id, order.cookId),
    }));
  if (!profile) return false;
  const schedule = await scheduleForCook(db, profile, order.mealType as MealPeriod);
  return !isBeforeCutoff(
    order.mealType as MealPeriod,
    new Date(),
    order.serviceDate,
    schedule.cutoff,
  );
}

type ActivityChannel = "VOICE_IVR" | "WHATSAPP_BOT" | "WEB_STOREFRONT" | "SYSTEM_CRON" | "ADMIN";

async function finalizeCancelInTx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  order: typeof orders.$inferSelect,
  cook: { kitchenName: string },
  wasPaid: boolean,
  activityChannel: ActivityChannel = "WEB_STOREFRONT",
) {
  assertTransition(order.status as OrderState, "CANCELLED");
  const [updated] = await tx
    .update(orders)
    .set({
      status: "CANCELLED",
      updatedAt: new Date(),
      idempotencyKey: null,
    })
    .where(eq(orders.id, order.id))
    .returning();
  await enqueueOutbox(tx, "OrderCancelled", {
      orderId: order.id,
      publicId: order.publicId,
      checkoutId: order.checkoutId,
      customerMobile: order.customerMobile,
      kitchenName: cook.kitchenName,
      itemName: order.itemName,
      qty: order.qty,
      serviceDate: order.serviceDate,
      wasPaid,
    });
  const { recordOrderActivity } = await import("./orderActivity.js");
  await recordOrderActivity(tx, {
    orderId: order.id,
    customerMobile: order.customerMobile,
    cookId: order.cookId,
    channel: activityChannel,
    eventName: "ORDER_CANCELLED",
    payload: {
      wasPaid,
      fromStatus: order.status,
      serviceDate: order.serviceDate,
      mealType: order.mealType,
      checkoutId: order.checkoutId,
    },
  });
  return updated;
}

export async function cancelOrder(
  db: Db,
  publicId: string,
  opts: { channel?: ActivityChannel } = {},
) {
  const activityChannel = opts.channel ?? "WEB_STOREFRONT";
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!order) throw new Error("Order not found");
  if (order.status === "CANCELLED") {
    return { ...order, cancellable: false, cancelRequestable: false, mode: "already_cancelled" as const };
  }
  if (order.status === "CANCEL_REQUESTED") {
    return {
      ...order,
      cancellable: false,
      cancelRequestable: false,
      mode: "cancel_requested" as const,
    };
  }

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, order.cookId),
  });
  if (!cook) throw new Error("Cook not found");

  // After cut-off on PAID → request cook approval instead of hard-failing.
  if (
    order.status === "PAID" &&
    (await isOrderCancelRequestable(db, order, cook))
  ) {
    return requestCancelOrder(db, publicId, { channel: activityChannel });
  }

  await assertCustomerCanCancelInstant(db, order, cook);
  const wasPaid = order.status === "PAID";

  // Paid + before cut-off → auto full refund (food after week discount + line fees).
  if (wasPaid) {
    const { refundOrder } = await import("./admin.js");
    const refunded = await refundOrder(db, {
      orderId: order.id,
      mode: "FULL",
      reason: "Customer cancelled before cut-off",
    });
    return {
      ...refunded,
      cancellable: false,
      cancelRequestable: false,
      mode: "refunded" as const,
    };
  }

  const updated = await db.transaction(async (tx) =>
    finalizeCancelInTx(tx, order, cook, wasPaid, activityChannel),
  );
  return {
    ...updated,
    cancellable: false,
    cancelRequestable: false,
    mode: "cancelled" as const,
  };
}

/** Customer asks kitchen to cancel after cut-off (PAID only). */
export async function requestCancelOrder(
  db: Db,
  publicId: string,
  opts: { channel?: ActivityChannel } = {},
) {
  const activityChannel = opts.channel ?? "WEB_STOREFRONT";
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!order) throw new Error("Order not found");
  if (order.status === "CANCEL_REQUESTED") {
    return {
      ...order,
      cancellable: false,
      cancelRequestable: false,
      mode: "cancel_requested" as const,
    };
  }
  if (order.status !== "PAID") {
    throw new Error("Only paid orders waiting for the kitchen can request a cancel after cut-off");
  }
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, order.cookId),
  });
  if (!cook) throw new Error("Cook not found");
  if (!(await isOrderCancelRequestable(db, order, cook))) {
    throw new Error("Use Cancel before cut-off — kitchen request is only after cut-off");
  }
  assertTransition("PAID", "CANCEL_REQUESTED");

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(orders)
      .set({ status: "CANCEL_REQUESTED", updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();
    await enqueueOutbox(tx, "CancelRequested", {
        orderId: order.id,
        publicId: order.publicId,
        cookMobile: cook.mobileNumber,
        cookId: cook.id,
        kitchenName: cook.kitchenName,
        customerMobile: order.customerMobile,
        itemName: order.itemName,
        qty: order.qty,
        serviceDate: order.serviceDate,
        mealType: order.mealType,
        deliveryTargetAddress: order.deliveryTargetAddress,
      });
    await enqueueOutbox(tx, "OrderStatusChanged", {
        publicId: order.publicId,
        customerMobile: order.customerMobile,
        kitchenName: cook.kitchenName,
        itemName: order.itemName,
        qty: order.qty,
        toStatus: "CANCEL_REQUESTED",
      });
    const { recordOrderActivity } = await import("./orderActivity.js");
    await recordOrderActivity(tx, {
      orderId: order.id,
      customerMobile: order.customerMobile,
      cookId: order.cookId,
      channel: activityChannel,
      eventName: "ORDER_CANCEL_REQUESTED",
      payload: {
        serviceDate: order.serviceDate,
        mealType: order.mealType,
        afterCutoff: true,
      },
    });
    return {
      ...updated,
      cancellable: false,
      cancelRequestable: false,
      mode: "cancel_requested" as const,
    };
  });
}

/** Cook allows post–cut-off cancel → refund paid order. */
export async function acceptCancelRequest(
  db: Db,
  publicId: string,
  opts: { channel?: ActivityChannel } = {},
) {
  const activityChannel = opts.channel ?? "WEB_STOREFRONT";
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!order) throw new Error("Order not found");
  if (order.status !== "CANCEL_REQUESTED") {
    throw new Error("No cancel request pending for this order");
  }
  const { recordOrderActivity } = await import("./orderActivity.js");
  await recordOrderActivity(db, {
    orderId: order.id,
    customerMobile: order.customerMobile,
    cookId: order.cookId,
    channel: activityChannel,
    eventName: "ORDER_CANCEL_ACCEPTED",
    payload: { by: "cook" },
  });
  const { refundOrder } = await import("./admin.js");
  return refundOrder(db, {
    orderId: order.id,
    mode: "FULL",
    reason: "Cook accepted customer cancel request after cut-off",
  });
}

/** Cook declines — order returns to PAID kitchen queue. */
export async function declineCancelRequest(
  db: Db,
  publicId: string,
  reason?: string,
  opts: { channel?: ActivityChannel } = {},
) {
  const activityChannel = opts.channel ?? "WEB_STOREFRONT";
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!order) throw new Error("Order not found");
  if (order.status !== "CANCEL_REQUESTED") {
    throw new Error("No cancel request pending for this order");
  }
  assertTransition("CANCEL_REQUESTED", "PAID");
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, order.cookId),
  });

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(orders)
      .set({ status: "PAID", updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();
    await enqueueOutbox(tx, "CancelDeclined", {
        publicId: order.publicId,
        customerMobile: order.customerMobile,
        kitchenName: cook?.kitchenName,
        itemName: order.itemName,
        qty: order.qty,
        reason: reason?.slice(0, 200) || "Kitchen could not cancel — food is being prepared",
      });
    const { recordOrderActivity } = await import("./orderActivity.js");
    await recordOrderActivity(tx, {
      orderId: order.id,
      customerMobile: order.customerMobile,
      cookId: order.cookId,
      channel: activityChannel,
      eventName: "ORDER_CANCEL_DECLINED",
      payload: {
        reason: reason?.slice(0, 200) || "Kitchen could not cancel — food is being prepared",
      },
    });
    return { ...updated, mode: "cancel_declined" as const };
  });
}

export async function listPendingCancelRequests(db: Db, cookSlug: string, date?: string) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Kitchen not found");
  const today = serviceDateISO();
  // With ?date= show that day; otherwise all pending asks from today forward (week cart).
  const rows = await db.query.orders.findMany({
    where: (t, { eq: e, and: a, gte: g }) =>
      date
        ? a(e(t.cookId, cook.id), e(t.status, "CANCEL_REQUESTED"), e(t.serviceDate, date))
        : a(e(t.cookId, cook.id), e(t.status, "CANCEL_REQUESTED"), g(t.serviceDate, today)),
    orderBy: (t, { asc }) => [asc(t.serviceDate), asc(t.createdAt)],
  });
  return {
    cookSlug,
    serviceDate: date ?? today,
    orders: rows.map((o) => ({
      publicId: o.publicId,
      itemName: o.itemName,
      qty: o.qty,
      customerMobile: o.customerMobile,
      status: o.status,
      mealType: o.mealType,
      serviceDate: o.serviceDate,
      deliveryTargetAddress: o.deliveryTargetAddress,
    })),
  };
}

/** Cancel every cancellable day-line in a week checkout. */
export async function cancelCheckout(
  db: Db,
  checkoutId: string,
  opts: { channel?: ActivityChannel } = {},
) {
  const rows = await db.query.orders.findMany({
    where: (t, { eq: e }) => e(t.checkoutId, checkoutId),
    orderBy: (t, { asc }) => [asc(t.serviceDate)],
  });
  if (!rows.length) throw new Error("Checkout not found");

  const cancelled = [];
  const skipped = [];
  for (const order of rows) {
    if (order.status === "CANCELLED") {
      skipped.push({ publicId: order.publicId, reason: "already cancelled" });
      continue;
    }
    try {
      const updated = await cancelOrder(db, order.publicId, opts);
      cancelled.push(updated);
    } catch (e) {
      skipped.push({ publicId: order.publicId, reason: (e as Error).message });
    }
  }
  if (!cancelled.length) {
    throw new Error(
      skipped[0]?.reason ?? "Nothing left to cancel in this week order",
    );
  }
  const modes = cancelled.map((o) => o.mode);
  const mode = modes.every((m) => m === "refunded")
    ? ("refunded" as const)
    : modes.every((m) => m === "cancel_requested")
      ? ("cancel_requested" as const)
      : ("cancelled" as const);
  return {
    checkoutId,
    mode,
    cancelled: cancelled.map((o) => o.publicId),
    skipped,
    orders: cancelled,
  };
}

/** Customer asks for lunch after cut-off — no payment until cook accepts. */
export async function requestLateOrder(
  db: Db,
  input: {
    customerMobile: string;
    cookSlug: string;
    menuItemId: number;
    qty: number;
    spice: "NORMAL" | "LESS";
    channel?: "WEB_STOREFRONT" | "WHATSAPP_BOT";
    serviceDate?: string;
    addressId?: number | null;
    fulfillmentMode?: FulfillmentMode;
    payerMobile?: string | null;
  },
) {
  const { assertFeatureEnabled } = await import("./featureFlags.js");
  await assertFeatureEnabled(
    db,
    "ordering_enabled",
    "Ordering is temporarily paused — try again later",
  );
  await assertFeatureEnabled(db, "late_orders_enabled", "Late orders are temporarily paused");

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, input.cookSlug),
  });
  if (!cook) throw new Error("Kitchen not found");
  assertCanAcceptPaidOrders({
    onboardingStatus: cook.onboardingStatus,
    fssaiNumber: cook.fssaiNumber,
    isActive: cook.isActive,
    payoutUpiId: cook.payoutUpiId,
    payoutAccountNote: cook.payoutAccountNote,
    payoutBeneficiaryRef: cook.payoutBeneficiaryRef,
  });

  let payerMobile: string | null = null;
  if (input.payerMobile?.trim()) {
    await assertFeatureEnabled(
      db,
      "child_pays_enabled",
      "Child Pays is temporarily off — pay with this phone instead",
    );
    const { assertActiveFamilyLink, normalizeFamilyMobile } = await import("./family.js");
    payerMobile = normalizeFamilyMobile(input.payerMobile);
    await assertActiveFamilyLink(db, input.customerMobile, payerMobile);
  }

  const menu = await db.query.dailyMenus.findFirst({
    where: (t, { eq: e }) => e(t.id, input.menuItemId),
  });
  if (!menu || menu.cookId !== cook.id) throw new Error("Menu item not found");
  if (!menu.isAvailable) throw new Error("That plate is not available");

  const serviceDate = input.serviceDate ?? menu.serviceDate ?? serviceDateISO();
  assertIntakeOpen(cook.intakePausedDate, serviceDate);
  assertAdvanceServiceDate(serviceDate);
  assertMenuAppliesToDate(menu, serviceDate);

  const { fulfillmentMode, pickupLandmark, deliveryPaise: fulfillDeliveryPaise } =
    await resolveCheckoutFulfillment(db, cook, input.fulfillmentMode);

  const mealType = (menu.mealType ?? "LUNCH") as MealPeriod;
  const schedule = await scheduleForCook(db, cook, mealType);
  if (!schedule.enabled) {
    throw new Error(`${mealLabel(mealType)} is not offered by this kitchen`);
  }
  if (isBeforeCutoff(mealType, new Date(), serviceDate, schedule.cutoff)) {
    throw new Error(
      `Cut-off not reached yet (${formatCutoffLabel(schedule.cutoff)}) — place a normal order`,
    );
  }

  const channel = input.channel ?? "WEB_STOREFRONT";
  const { address, deliveryTargetAddress } = await resolveCheckoutAddress(db, {
    customerMobile: input.customerMobile,
    cookPin: cook.pinCode,
    fulfillmentMode,
    pickupLandmark,
    addressId: input.addressId,
    channel,
  });
  await assertCapacity(db, cook.id, serviceDate, input.qty);

  const deliveryPaise = await applyDeliveryDistancePaise(db, {
    cook,
    address,
    fulfillmentMode,
    baseDeliveryPaise: fulfillDeliveryPaise,
  });
  const feePaise = platformFeePaise();
  const amountPaise = orderTotalPaise({
    foodPaise: menu.pricePaise,
    deliveryPaise,
    platformFeePaise: feePaise,
    qty: input.qty,
  });
  const idempotencyKey = buildIdempotencyKey({
    customerMobile: input.customerMobile,
    cookId: cook.id,
    mealType,
    serviceDate,
    amountPaise,
    menuItemId: menu.id,
    spice: input.spice,
    late: true,
    fulfillmentMode,
  });

  let lateIdempotencyKey = idempotencyKey;
  const existing = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.idempotencyKey, lateIdempotencyKey),
  });
  if (existing) {
    if (existing.status === "PENDING_APPROVAL" || existing.status === "AWAITING_PAYMENT") {
      return { ...existing, pendingApproval: existing.status === "PENDING_APPROVAL" };
    }
    // Prior late/paid order with same plate — allow another request.
    lateIdempotencyKey = `${lateIdempotencyKey}|addl|${publicId()}`;
  }

  return db.transaction(async (tx) => {
    const pid = publicId();
    const traceId = newTraceId();
    bindTrace({ traceId, publicId: pid });
    const [order] = await tx
      .insert(orders)
      .values({
        publicId: pid,
        traceId,
        customerMobile: input.customerMobile,
        payerMobile,
        cookId: cook.id,
        menuItemId: menu.id,
        addressId: address.id,
        mealType,
        serviceDate,
        itemName: menu.itemName,
        itemNameTa: menu.itemNameTa ?? null,
        qty: input.qty,
        spice: input.spice,
        foodPaise: menu.pricePaise,
        deliveryPaise,
        platformFeePaise: feePaise,
        status: "PENDING_APPROVAL",
        fulfillmentMode,
        deliveryTargetAddress,
        channel,
        idempotencyKey: lateIdempotencyKey,
      })
      .returning();

    await tx.insert(platformEventLedger).values({
      associatedMobile: input.customerMobile,
      orderId: order.id,
      cookId: cook.id,
      channel,
      eventName: "LATE_ORDER_REQUESTED",
      rawPayload: { publicId: order.publicId, serviceDate, fulfillmentMode },
    });

    await enqueueOutbox(tx, "LateOrderRequested", {
        orderId: order.id,
        publicId: order.publicId,
        traceId: order.traceId,
        cookId: cook.id,
        cookMobile: cook.mobileNumber,
        cookSlug: cook.slugHandle,
        kitchenName: cook.kitchenName,
        customerMobile: input.customerMobile,
        payerMobile,
        itemName: order.itemName,
        qty: order.qty,
        spice: order.spice,
        serviceDate,
        fulfillmentMode,
        deliveryTargetAddress: order.deliveryTargetAddress,
        totalPaise: amountPaise,
      });

    return { ...order, pendingApproval: true };
  });
}

/** Cook accepts a late request → create UPI link (customer pays next). */
export async function approveLateOrder(db: Db, publicId: string) {
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!order) throw new Error("Order not found");
  if (order.status !== "PENDING_APPROVAL") {
    throw new Error(`Order is ${order.status}, not waiting for cook approval`);
  }
  assertTransition("PENDING_APPROVAL", "AWAITING_PAYMENT");

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, order.cookId),
  });
  if (!cook) throw new Error("Cook not found");

  const amountPaise = orderTotalPaise({
    foodPaise: order.foodPaise,
    deliveryPaise: order.deliveryPaise,
    platformFeePaise: order.platformFeePaise,
    qty: order.qty,
  });
  const pay = getPaymentProvider();
  const payKey = `${order.idempotencyKey}|pay`;
  const billMobile = order.payerMobile ?? order.customerMobile;

  return db.transaction(async (tx) => {
    bindTrace({
      traceId: order.traceId,
      publicId: order.publicId,
      checkoutId: order.checkoutId,
      customerMobile: order.customerMobile,
      cookId: order.cookId,
      orderId: order.id,
      status: "AWAITING_PAYMENT",
      amountPaise,
      mealType: order.mealType,
      serviceDate: order.serviceDate,
    });
    orderLog.info(
      {
        event: LogEvent.THIRD_PARTY_REQUEST,
        provider: "payment",
        action: "createPayment",
        ...orderTriageFields({
          traceId: order.traceId,
          publicId: order.publicId,
          orderId: order.id,
          customerMobile: order.customerMobile,
          cookId: order.cookId,
          amountPaise,
          mealType: order.mealType,
          serviceDate: order.serviceDate,
          status: "AWAITING_PAYMENT",
        }),
      },
      "payment createPayment (late approve)",
    );
    const payment = await pay.createPayment({
      orderPublicId: order.publicId,
      amountPaise,
      customerMobile: billMobile,
      idempotencyKey: payKey,
      traceId: order.traceId,
    });

    await tx.insert(payments).values({
      orderId: order.id,
      kind: "CHARGE",
      amountPaise,
      status: "CREATED",
      gatewayTxnId: payment.gatewayTxnId,
      idempotencyKey: payKey,
    });

    const [updated] = await tx
      .update(orders)
      .set({
        status: "AWAITING_PAYMENT",
        gatewayTxnId: payment.gatewayTxnId,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id))
      .returning();

    await tx.insert(platformEventLedger).values({
      associatedMobile: cook.mobileNumber,
      orderId: order.id,
      cookId: cook.id,
      channel: order.channel,
      eventName: "LATE_ORDER_ACCEPTED",
      rawPayload: {
        publicId: order.publicId,
        paymentUrl: payment.paymentUrl,
        traceId: order.traceId,
      },
    });

    await enqueueOutbox(tx, "LateOrderApproved", {
        orderId: order.id,
        publicId: order.publicId,
        traceId: order.traceId,
        customerMobile: order.customerMobile,
        payerMobile: order.payerMobile,
        billMobile,
        cookMobile: cook.mobileNumber,
        kitchenName: cook.kitchenName,
        itemName: order.itemName,
        qty: order.qty,
        paymentUrl: payment.paymentUrl,
        gatewayTxnId: payment.gatewayTxnId,
      });

    if (order.payerMobile) {
      await enqueueOutbox(tx, "ChildPaysRequested", {
          checkoutId: null,
          orderPublicId: order.publicId,
          orderId: order.id,
          payerMobile: order.payerMobile,
          seniorMobile: order.customerMobile,
          kitchenName: cook.kitchenName,
          paymentUrl: payment.paymentUrl,
          amountPaise,
          lineCount: 1,
        });
      await tx.insert(platformEventLedger).values({
        associatedMobile: order.customerMobile,
        orderId: order.id,
        cookId: cook.id,
        channel: order.channel,
        eventName: "CHILD_PAYS_REQUESTED",
        rawPayload: {
          payerMobile: order.payerMobile,
          publicId: order.publicId,
          late: true,
        },
      });
    }

    return {
      ...updated,
      paymentUrl: payment.paymentUrl,
      gatewayTxnId: payment.gatewayTxnId,
    };
  });
}

export async function declineLateOrder(db: Db, publicId: string, reason?: string) {
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!order) throw new Error("Order not found");
  if (order.status !== "PENDING_APPROVAL") {
    throw new Error(`Order is ${order.status}, not waiting for cook approval`);
  }
  assertTransition("PENDING_APPROVAL", "CANCELLED");

  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, order.cookId),
  });

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(orders)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(eq(orders.id, order.id))
      .returning();

    await enqueueOutbox(tx, "LateOrderDeclined", {
        orderId: order.id,
        publicId: order.publicId,
        customerMobile: order.customerMobile,
        cookMobile: cook?.mobileNumber ?? null,
        kitchenName: cook?.kitchenName ?? null,
        itemName: order.itemName,
        reason: reason ?? "Kitchen could not take a late order",
      });

    return updated;
  });
}

export async function listPendingLateOrders(
  db: Db,
  cookSlug: string,
  serviceDate = serviceDateISO(),
) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  const rows = await db.query.orders.findMany({
    where: (t, { eq: e, and: a }) =>
      a(
        e(t.cookId, cook.id),
        e(t.serviceDate, serviceDate),
        e(t.status, "PENDING_APPROVAL"),
      ),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  return {
    cook: { id: cook.id, kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
    serviceDate,
    orders: rows,
  };
}

export async function transitionOrder(
  db: Db,
  orderId: number,
  to: OrderState,
  extra?: Partial<typeof orders.$inferInsert>,
  activity?: {
    channel?: "VOICE_IVR" | "WHATSAPP_BOT" | "WEB_STOREFRONT" | "SYSTEM_CRON" | "ADMIN";
  },
) {
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.id, orderId),
  });
  if (!order) throw new Error("Order not found");
  const fromStatus = order.status as OrderState;
  assertTransition(fromStatus, to);
  const [updated] = await db
    .update(orders)
    .set({ status: to, updatedAt: new Date(), ...extra })
    .where(eq(orders.id, orderId))
    .returning();

  // Kitchen / logistics path timing for ops timeline (Admin order activity).
  const { recordOrderActivity } = await import("./orderActivity.js");
  await recordOrderActivity(db, {
    orderId: order.id,
    customerMobile: order.customerMobile,
    cookId: order.cookId,
    channel: activity?.channel ?? "SYSTEM_CRON",
    eventName: `ORDER_STATUS_${to}`,
    payload: {
      fromStatus,
      toStatus: to,
      serviceDate: order.serviceDate,
      mealType: order.mealType,
      fulfillmentMode: order.fulfillmentMode,
      logisticsMode: updated.logisticsMode ?? order.logisticsMode,
      publicId: order.publicId,
    },
  });

  if (order.traceId) {
    bindTrace({
      traceId: order.traceId,
      publicId: order.publicId,
      checkoutId: order.checkoutId,
      customerMobile: order.customerMobile,
      cookId: order.cookId,
      orderId: order.id,
      status: to,
      mealType: order.mealType,
      serviceDate: order.serviceDate,
      amountPaise: lineTotal(order),
    });
  }
  orderLog.info(
    {
      event: LogEvent.ORDER_STATUS_CHANGED,
      fromStatus,
      toStatus: to,
      channel: activity?.channel ?? "SYSTEM_CRON",
      ...orderTriageFields({
        traceId: order.traceId,
        publicId: order.publicId,
        checkoutId: order.checkoutId,
        orderId: order.id,
        customerMobile: order.customerMobile,
        cookId: order.cookId,
        status: to,
        amountPaise: lineTotal(order),
        mealType: order.mealType,
        serviceDate: order.serviceDate,
        itemName: order.itemName,
        qty: order.qty,
        fulfillmentMode: order.fulfillmentMode,
        channel: order.channel,
      }),
      logisticsMode: updated.logisticsMode ?? order.logisticsMode ?? null,
    },
    "order status changed",
  );

  return updated;
}

export async function getOrderByPublicId(db: Db, publicId: string) {
  return db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
}

export async function findLatestAwaitingPayment(db: Db, customerMobile: string) {
  const rows = await db.query.orders.findMany({
    where: (t, { eq: e, and: a }) =>
      a(e(t.customerMobile, customerMobile), e(t.status, "AWAITING_PAYMENT")),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 1,
  });
  const order = rows[0];
  if (!order) return null;
  return {
    ...order,
    paymentUrl: await resolveCustomerPaymentUrl(db, {
      orderId: order.id,
      publicId: order.publicId,
      gatewayTxnId: order.gatewayTxnId,
      checkoutId: order.checkoutId,
    }),
  };
}

export async function findAwaitingPaymentByPublicId(
  db: Db,
  customerMobile: string,
  publicId: string,
) {
  const order = await db.query.orders.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(
        e(t.publicId, publicId),
        e(t.customerMobile, customerMobile),
        e(t.status, "AWAITING_PAYMENT"),
      ),
  });
  if (!order) return null;
  return {
    ...order,
    paymentUrl: await resolveCustomerPaymentUrl(db, {
      orderId: order.id,
      publicId: order.publicId,
      gatewayTxnId: order.gatewayTxnId,
      checkoutId: order.checkoutId,
    }),
  };
}

/**
 * Drop unpaid / failed-pay / late-pending rows whose service date is already past.
 * Quiet cancel (no customer WA) — they can no longer receive that meal.
 */
export async function expireUnpaidOrdersPastServiceDate(
  db: Db,
  asOfDate = serviceDateISO(),
  limit = 200,
) {
  const stale = await db
    .select({
      id: orders.id,
      publicId: orders.publicId,
      status: orders.status,
      serviceDate: orders.serviceDate,
      customerMobile: orders.customerMobile,
    })
    .from(orders)
    .where(
      and(
        inArray(orders.status, ["AWAITING_PAYMENT", "PENDING_APPROVAL", "FAILED"]),
        lt(orders.serviceDate, asOfDate),
      ),
    )
    .limit(limit);

  let cancelled = 0;
  for (const row of stale) {
    try {
      assertTransition(row.status as OrderState, "CANCELLED");
      await db
        .update(orders)
        .set({
          status: "CANCELLED",
          idempotencyKey: null,
          gatewayTxnId: null,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, row.id));
      await db.insert(platformEventLedger).values({
        associatedMobile: row.customerMobile,
        orderId: row.id,
        channel: "WEB_STOREFRONT",
        eventName: "UNPAID_EXPIRED",
        rawPayload: {
          publicId: row.publicId,
          serviceDate: row.serviceDate,
          previousStatus: row.status,
          asOfDate,
        },
      });
      cancelled += 1;
    } catch (err) {
      orderLog.warn(
        {
          event: LogEvent.ORDER_UNPAID_EXPIRED,
          publicId: row.publicId,
          err: err instanceof Error ? err.message : String(err),
        },
        "expire unpaid past service date skipped",
      );
    }
  }

  if (cancelled > 0) {
    orderLog.info(
      { event: LogEvent.ORDER_UNPAID_EXPIRED, cancelled, asOfDate },
      "expired unpaid orders past service date",
    );
  }
  return { asOfDate, scanned: stale.length, cancelled };
}

/** Customer order history (newest first), with kitchen name when available. */
export async function listOrdersForCustomer(
  db: Db,
  customerMobile: string,
  opts: number | { limit?: number; offset?: number } = 50,
) {
  // Keep Open clean: unpaid for yesterday (or earlier) should not stay Pay-now.
  await expireUnpaidOrdersPastServiceDate(db);

  const parsed = typeof opts === "number" ? { limit: opts } : opts;
  const limit = Math.min(Math.max(parsed.limit ?? 50, 1), 100);
  const offset = Math.max(parsed.offset ?? 0, 0);

  const rows = await db.query.orders.findMany({
    where: (t, { eq: e, or: o }) =>
      o(e(t.customerMobile, customerMobile), e(t.payerMobile, customerMobile)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: limit + 1,
    offset,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const cooks = await db.query.cookProfiles.findMany();
  const byId = new Map(cooks.map((c) => [c.id, c]));
  const { reviewFlagsForOrders } = await import("./reviews.js");
  const flags = await reviewFlagsForOrders(db, page);
  const out = [];
  for (const o of page) {
    const cook = byId.get(o.cookId);
    const review = flags.get(o.id) ?? { canReview: false, hasReview: false };
    const isPayerOnly =
      o.payerMobile === customerMobile && o.customerMobile !== customerMobile;
    out.push({
      id: o.id,
      publicId: o.publicId,
      checkoutId: o.checkoutId,
      status: o.status,
      itemName: o.itemName,
      itemNameTa: o.itemNameTa ?? null,
      qty: o.qty,
      spice: o.spice,
      menuItemId: o.menuItemId,
      foodPaise: o.foodPaise,
      foodDiscountPaise: o.foodDiscountPaise ?? 0,
      weekDiscountPercent: o.weekDiscountPercent ?? null,
      deliveryPaise: o.deliveryPaise,
      platformFeePaise: o.platformFeePaise,
      totalPaise: lineTotal(o),
      serviceDate: o.serviceDate,
      mealType: o.mealType,
      deliveryTargetAddress: o.deliveryTargetAddress,
      fulfillmentMode: (o.fulfillmentMode as FulfillmentMode) || "DELIVERY",
      logisticsMode: o.logisticsMode === "PARTNER" ? "PARTNER" : "SELF",
      kitchenDeliveryType: cook?.deliveryType === "PARTNER" ? "PARTNER" : "SELF",
      partnerShipmentId: o.partnerShipmentId ?? null,
      partnerTrackingUrl:
        o.logisticsMode === "PARTNER"
          ? o.partnerTrackingUrl?.trim() ||
            (o.partnerShipmentId
              ? `https://localmeals.local/track/${o.partnerShipmentId}`
              : null)
          : null,
      pickup: pickupRevealForOrder(o),
      deliveryWindow: cook
        ? formatDeliveryWindowLabel(
            (await scheduleForCook(db, cook, (o.mealType as MealPeriod) || "LUNCH")).deliveryWindow,
          )
        : null,
      channel: o.channel,
      gatewayTxnId: o.gatewayTxnId,
      createdAt: o.createdAt,
      kitchenName: cook?.kitchenName ?? null,
      cookSlug: cook?.slugHandle ?? null,
      canReorder: Boolean(cook?.slugHandle && o.menuItemId),
      payerMobile: o.payerMobile,
      childPays: Boolean(o.payerMobile),
      roleOnOrder: isPayerOnly ? ("PAYER" as const) : ("CUSTOMER" as const),
      cancellable: isPayerOnly ? false : await isOrderCancellable(db, o, cook),
      cancelRequestable: isPayerOnly ? false : await isOrderCancelRequestable(db, o, cook),
      canReview: isPayerOnly ? false : review.canReview,
      hasReview: review.hasReview,
      paymentUrl:
        o.status === "AWAITING_PAYMENT" ||
        o.status === "CONFIRMING_PAYMENT" ||
        o.status === "FAILED"
          ? await resolveCustomerPaymentUrl(db, {
              orderId: o.id,
              publicId: o.publicId,
              gatewayTxnId: o.gatewayTxnId,
              checkoutId: o.checkoutId,
            })
          : undefined,
    });
  }
  return {
    orders: out,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
  };
}

export async function findCookBySlug(db: Db, slug: string) {
  return db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, slug),
  });
}

export async function findCookById(db: Db, id: string) {
  return db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, id),
  });
}
