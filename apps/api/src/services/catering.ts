/**
 * MVP-3 party / bulk catering. Fully separate from lunch orders: own tables, own state machine
 * (domain/catering.ts), own payment rows. The only shared touch point is the Razorpay webhook,
 * which routes CAT-… captures here before the lunch path.
 *
 * `catering_enabled` (default OFF) gates new commitments only — combos, settings, public listing,
 * new bookings and fresh advance links. Existing bookings keep working (balance pay, cancel,
 * refunds, admin) so switching the flag off never strands customer money.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import {
  adminActionLog,
  cateringBookings,
  cateringCombos,
  cateringPayments,
  cookCateringSettings,
  users,
  type Db,
  type DbOrTx,
} from "@localmeals/db";
import {
  CATERING_CUTOFF_HOURS_MAX,
  CATERING_CUTOFF_HOURS_MIN,
  CATERING_DEFAULT_CUTOFF_HOURS,
  CATERING_DEFAULT_DAILY_PLATE_CAP,
  CATERING_MAX_DAYS_AHEAD,
  CATERING_MAX_PLATES,
  CATERING_MIN_MOQ,
  DomainError,
  addDaysISO,
  assertCateringBookable,
  assertCateringCombo,
  assertCateringCutoffHours,
  assertCateringTransition,
  assertFulfillmentAllowed,
  cateringAmounts,
  cateringCutoffAt,
  cateringDuePhase,
  cateringEventStartAt,
  cookFulfillmentOffersFromRow,
  customerCanCancelCatering,
  isFeatureEnabled,
  needsCheckoutAddress,
  normalizeFulfillmentMode,
  serviceDateISO,
  type CateringPaymentPhase,
  type CateringStatus,
  type FulfillmentMode,
} from "@localmeals/domain";
import {
  PAYMENT_LINK_TTL_SEC,
  UNPAID_HOLD_TTL_SEC,
  getPaymentProvider,
} from "@localmeals/adapters";
import { createServiceLogger, newTraceId } from "@localmeals/observability";
import { enqueueOutbox } from "./outboxEnqueue.js";
import { getFeatureFlags } from "./featureFlags.js";

const log = createServiceLogger("localmeals-api");

/** Balance links stay payable for 3 days (no unpaid hold to protect). Reused while ≥1h is left. */
const BALANCE_LINK_TTL_SEC = 3 * 24 * 3600;
const ADVANCE_LINK_MIN_LEFT_SEC = 5 * 60;
const BALANCE_LINK_MIN_LEFT_SEC = 3600;
/** Balance WhatsApp reminder goes out once, when the event is this close. */
const BALANCE_REMINDER_HOURS = 48;

const PAID_LIKE: CateringStatus[] = ["ADVANCE_PAID", "PAID", "COMPLETED"];

type Booking = typeof cateringBookings.$inferSelect;
type Combo = typeof cateringCombos.$inferSelect;
type Payment = typeof cateringPayments.$inferSelect;
type Cook = NonNullable<Awaited<ReturnType<Db["query"]["cookProfiles"]["findFirst"]>>>;

function webOrigin() {
  return process.env.WEB_ORIGIN ?? "http://localhost:3000";
}

export function cateringBookingUrl(publicId: string) {
  return `${webOrigin()}/catering/bookings/${publicId}`;
}

function newCateringPublicId() {
  return `CAT-${randomBytes(5).toString("hex").toUpperCase()}`;
}

const disabledError = () =>
  new DomainError("Party orders are not available right now", 404, "catering_disabled");

async function cateringPlatformEnabled(db: Db) {
  return isFeatureEnabled(await getFeatureFlags(db), "catering_enabled");
}

async function assertCateringOn(db: Db) {
  if (!(await cateringPlatformEnabled(db))) throw disabledError();
}

async function findCookBySlug(db: Db, slug: string) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, slug),
  });
  if (!cook) throw DomainError.notFound("Kitchen not found");
  return cook;
}

async function settingsFor(db: DbOrTx, cookId: string) {
  const row = await db.query.cookCateringSettings.findFirst({
    where: (t, { eq: e }) => e(t.cookId, cookId),
  });
  return {
    enabled: row?.enabled ?? false,
    cutoffHours: row?.cutoffHours ?? CATERING_DEFAULT_CUTOFF_HOURS,
    dailyPlateCap: row?.dailyPlateCap ?? CATERING_DEFAULT_DAILY_PLATE_CAP,
  };
}

function isCookLive(cook: Cook) {
  return cook.onboardingStatus === "LIVE" && cook.isActive;
}

/** Kitchen open for new party bookings: platform flag + LIVE + cook opted in. */
async function loadOpenCateringKitchen(db: Db, slug: string) {
  await assertCateringOn(db);
  const cook = await findCookBySlug(db, slug);
  const settings = await settingsFor(db, cook.id);
  if (!isCookLive(cook) || !settings.enabled) throw disabledError();
  return { cook, settings };
}

function comboDto(c: Combo) {
  return {
    id: c.id,
    name: c.name,
    nameTa: c.nameTa,
    contents: c.contents,
    pricePerPlatePaise: c.pricePerPlatePaise,
    minPlates: c.minPlates,
    maxPlates: c.maxPlates,
    isVeg: c.isVeg,
    imageUrl: c.imageUrl,
    isActive: c.isActive,
  };
}

function totalPaise(b: Booking) {
  return b.foodPaise + b.platformFeePaise;
}

function paymentWindowLeftSec(p: Payment, now = Date.now()) {
  const ttl = p.phase === "ADVANCE" ? PAYMENT_LINK_TTL_SEC : BALANCE_LINK_TTL_SEC;
  return ttl - Math.floor((now - p.createdAt.getTime()) / 1000);
}

function openLinkFor(payments: Payment[], phase: CateringPaymentPhase | null) {
  if (!phase) return null;
  const minLeft = phase === "ADVANCE" ? ADVANCE_LINK_MIN_LEFT_SEC : BALANCE_LINK_MIN_LEFT_SEC;
  return (
    payments
      .filter((p) => p.phase === phase && p.status === "CREATED" && p.paymentUrl)
      .sort((a, b) => b.id - a.id)
      .find((p) => paymentWindowLeftSec(p) >= minLeft) ?? null
  );
}

async function paymentsFor(db: DbOrTx, bookingId: number) {
  return db.query.cateringPayments.findMany({
    where: (t, { eq: e }) => e(t.bookingId, bookingId),
    orderBy: (t, { asc }) => [asc(t.id)],
  });
}

function bookingView(
  b: Booking,
  cook: Pick<Cook, "slugHandle" | "kitchenName" | "pickupLandmark">,
  payments: Payment[],
  audience: "CUSTOMER" | "COOK" | "ADMIN",
) {
  const duePhase = cateringDuePhase(b.status as CateringStatus);
  const link = openLinkFor(payments, duePhase);
  const paidPaise = payments
    .filter((p) => p.phase !== "REFUND" && p.status === "PAID")
    .reduce((s, p) => s + p.amountPaise, 0);
  const advancePaid = PAID_LIKE.includes(b.status as CateringStatus) || paidPaise > 0;
  const view = {
    publicId: b.publicId,
    status: b.status as CateringStatus,
    kitchenSlug: cook.slugHandle,
    kitchenName: cook.kitchenName,
    comboId: b.comboId,
    comboName: b.comboName,
    comboContents: b.comboContents,
    plates: b.plates,
    pricePerPlatePaise: b.pricePerPlatePaise,
    foodPaise: b.foodPaise,
    platformFeePaise: b.platformFeePaise,
    totalPaise: totalPaise(b),
    advancePaise: b.advancePaise,
    balancePaise: b.balancePaise,
    paidPaise,
    refundedPaise: b.refundedPaise,
    eventDate: b.eventDate,
    eventTime: b.eventTime,
    cutoffAt: b.cutoffAt.toISOString(),
    fulfillmentMode: b.fulfillmentMode as FulfillmentMode,
    note: b.note,
    duePhase,
    duePaise: duePhase === "ADVANCE" ? b.advancePaise : duePhase === "BALANCE" ? b.balancePaise : 0,
    paymentUrl: link?.paymentUrl ?? null,
    canCustomerCancel: customerCanCancelCatering(b.status as CateringStatus, b.cutoffAt),
    cancelledBy: b.cancelledBy,
    cancelReason: b.cancelReason,
    createdAt: b.createdAt.toISOString(),
    // Address / landmark / contact only once money is committed (same rule as lunch pickup landmark).
    deliveryAddress: audience === "CUSTOMER" || advancePaid ? b.deliveryAddress : null,
    pickupLandmark:
      b.fulfillmentMode === "PICKUP" && advancePaid ? (cook.pickupLandmark ?? null) : null,
    customerMobile: audience === "CUSTOMER" || advancePaid ? b.customerMobile : null,
  };
  if (audience !== "ADMIN") return view;
  return {
    ...view,
    cookPaidAt: b.cookPaidAt?.toISOString() ?? null,
    cookPaidUtr: b.cookPaidUtr,
    payments: payments.map((p) => ({
      id: p.id,
      phase: p.phase,
      amountPaise: p.amountPaise,
      status: p.status,
      method: p.method,
      gatewayTxnId: p.gatewayTxnId,
      paymentId: p.paymentId,
      createdAt: p.createdAt.toISOString(),
      paidAt: p.paidAt?.toISOString() ?? null,
    })),
  };
}

async function viewFor(db: DbOrTx, b: Booking, audience: "CUSTOMER" | "COOK" | "ADMIN") {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, b.cookId),
  });
  return bookingView(
    b,
    cook ?? { slugHandle: "", kitchenName: "Kitchen", pickupLandmark: null },
    await paymentsFor(db, b.id),
    audience,
  );
}

/** Plates held or booked on a date. Unpaid holds count only while their advance link is live. */
async function bookedPlatesOnDate(
  tx: DbOrTx,
  cookId: string,
  eventDate: string,
  excludeBookingId?: number,
) {
  const holdSince = new Date(Date.now() - UNPAID_HOLD_TTL_SEC * 1000);
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${cateringBookings.plates}), 0)::int` })
    .from(cateringBookings)
    .where(
      and(
        eq(cateringBookings.cookId, cookId),
        eq(cateringBookings.eventDate, eventDate),
        excludeBookingId ? ne(cateringBookings.id, excludeBookingId) : undefined,
        or(
          inArray(cateringBookings.status, PAID_LIKE),
          and(
            eq(cateringBookings.status, "AWAITING_ADVANCE"),
            gt(cateringBookings.updatedAt, holdSince),
          ),
        ),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Serialise capacity checks per kitchen + date (two customers racing for the last plates). */
async function lockKitchenDate(tx: DbOrTx, cookId: string, eventDate: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`catering:${cookId}:${eventDate}`}))`);
}

/* ───────────────────────────── Cook desk ───────────────────────────── */

export async function getCookCateringDesk(db: Db, slug: string) {
  const cook = await findCookBySlug(db, slug);
  const settings = await settingsFor(db, cook.id);
  const combos = await db.query.cateringCombos.findMany({
    where: (t, { eq: e }) => e(t.cookId, cook.id),
    orderBy: (t, { asc }) => [asc(t.name)],
  });
  const since = addDaysISO(serviceDateISO(), -7);
  const rows = await db.query.cateringBookings.findMany({
    where: (t, { and: a, eq: e, gte }) => a(e(t.cookId, cook.id), gte(t.eventDate, since)),
    orderBy: (t, { asc }) => [asc(t.eventDate), asc(t.eventTime)],
    limit: 100,
  });
  const bookings = [];
  for (const b of rows) {
    // Unpaid holds are noise for the cook — show them only while the hold is live.
    if (
      b.status === "AWAITING_ADVANCE" &&
      Date.now() - b.updatedAt.getTime() > UNPAID_HOLD_TTL_SEC * 1000
    ) {
      continue;
    }
    bookings.push(bookingView(b, cook, await paymentsFor(db, b.id), "COOK"));
  }
  return {
    platformEnabled: await cateringPlatformEnabled(db),
    kitchenLive: isCookLive(cook),
    settings,
    limits: {
      minMoq: CATERING_MIN_MOQ,
      maxPlates: CATERING_MAX_PLATES,
      cutoffHoursMin: CATERING_CUTOFF_HOURS_MIN,
      cutoffHoursMax: CATERING_CUTOFF_HOURS_MAX,
    },
    combos: combos.map(comboDto),
    bookings,
  };
}

export async function updateCookCateringSettings(
  db: Db,
  slug: string,
  input: { enabled?: boolean; cutoffHours?: number; dailyPlateCap?: number },
) {
  await assertCateringOn(db);
  const cook = await findCookBySlug(db, slug);
  const current = await settingsFor(db, cook.id);
  const next = {
    enabled: input.enabled ?? current.enabled,
    cutoffHours: input.cutoffHours ?? current.cutoffHours,
    dailyPlateCap: input.dailyPlateCap ?? current.dailyPlateCap,
  };
  assertCateringCutoffHours(next.cutoffHours);
  if (
    !Number.isInteger(next.dailyPlateCap) ||
    next.dailyPlateCap < CATERING_MIN_MOQ ||
    next.dailyPlateCap > CATERING_MAX_PLATES * 3
  ) {
    throw new DomainError(
      `Daily party plate cap must be ${CATERING_MIN_MOQ}–${CATERING_MAX_PLATES * 3}`,
      400,
      "catering_cap",
    );
  }
  if (next.enabled && !isCookLive(cook)) {
    throw new DomainError("Only LIVE kitchens can take party orders", 400, "catering_not_live");
  }
  await db
    .insert(cookCateringSettings)
    .values({ cookId: cook.id, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: cookCateringSettings.cookId,
      set: { ...next, updatedAt: new Date() },
    });
  return { settings: next };
}

export async function upsertCateringCombo(
  db: Db,
  slug: string,
  input: {
    id?: number;
    name: string;
    nameTa?: string | null;
    contents?: string | null;
    pricePerPlatePaise: number;
    minPlates: number;
    maxPlates: number;
    isVeg?: boolean;
    imageUrl?: string | null;
    isActive?: boolean;
  },
) {
  await assertCateringOn(db);
  const cook = await findCookBySlug(db, slug);
  const values = {
    name: input.name.trim().slice(0, 100),
    nameTa: input.nameTa?.trim() || null,
    contents: input.contents?.trim() || null,
    pricePerPlatePaise: input.pricePerPlatePaise,
    minPlates: input.minPlates,
    maxPlates: input.maxPlates,
    isVeg: input.isVeg ?? true,
    imageUrl: input.imageUrl?.trim() || null,
    isActive: input.isActive ?? true,
    updatedAt: new Date(),
  };
  assertCateringCombo(values);
  if (input.id) {
    const [row] = await db
      .update(cateringCombos)
      .set(values)
      .where(and(eq(cateringCombos.id, input.id), eq(cateringCombos.cookId, cook.id)))
      .returning();
    if (!row) throw DomainError.notFound("Combo not found");
    return { combo: comboDto(row) };
  }
  const [row] = await db
    .insert(cateringCombos)
    .values({ ...values, cookId: cook.id })
    .onConflictDoNothing()
    .returning();
  if (!row) throw DomainError.conflict("A combo with this name already exists");
  return { combo: comboDto(row) };
}

/** Cook marks a fully paid party order as delivered / collected. */
export async function completeCateringBooking(db: Db, slug: string, publicId: string) {
  const cook = await findCookBySlug(db, slug);
  const b = await db.query.cateringBookings.findFirst({
    where: (t, { and: a, eq: e }) => a(e(t.publicId, publicId), e(t.cookId, cook.id)),
  });
  if (!b) throw DomainError.notFound("Booking not found");
  if (b.status === "ADVANCE_PAID") {
    throw DomainError.conflict("Balance is still due — ask the customer to pay before completing");
  }
  assertCateringTransition(b.status as CateringStatus, "COMPLETED");
  const [row] = await db
    .update(cateringBookings)
    .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(cateringBookings.id, b.id), eq(cateringBookings.status, b.status)))
    .returning();
  if (!row) throw DomainError.conflict("Booking changed — refresh and try again");
  return { booking: bookingView(row, cook, await paymentsFor(db, row.id), "COOK") };
}

/* ───────────────────────────── Customer ───────────────────────────── */

export async function getPublicKitchenCatering(db: Db, slug: string) {
  const { cook, settings } = await loadOpenCateringKitchen(db, slug);
  const combos = await db.query.cateringCombos.findMany({
    where: (t, { and: a, eq: e }) => a(e(t.cookId, cook.id), e(t.isActive, true)),
    orderBy: (t, { asc }) => [asc(t.pricePerPlatePaise)],
  });
  const flags = await getFeatureFlags(db);
  const offers = cookFulfillmentOffersFromRow(cook);
  const pickup =
    offers.pickup && Boolean(cook.pickupLandmark?.trim()) && isFeatureEnabled(flags, "pickup_enabled");
  const today = serviceDateISO();
  return {
    kitchenSlug: cook.slugHandle,
    kitchenName: cook.kitchenName,
    pinCode: cook.pinCode,
    cutoffHours: settings.cutoffHours,
    earliestEventDate: addDaysISO(today, Math.ceil(settings.cutoffHours / 24)),
    latestEventDate: addDaysISO(today, CATERING_MAX_DAYS_AHEAD),
    fulfillment: {
      cookDelivery: offers.cookDelivery,
      pickup,
      customerArrange: offers.customerArrange,
    },
    combos: combos.map(comboDto),
  };
}

async function ensureCustomerRow(db: Db, mobile: string, pinCode: string) {
  await db
    .insert(users)
    .values({
      mobileNumber: mobile,
      fullName: "Guest",
      primaryAddress: "Address on file",
      pinCode,
      segment: "BACHELOR",
    })
    .onConflictDoNothing();
}

export async function createCateringBooking(
  db: Db,
  input: {
    customerMobile: string;
    slug: string;
    comboId: number;
    plates: number;
    eventDate: string;
    eventTime: string;
    fulfillmentMode?: string;
    addressId?: number;
    note?: string | null;
    idempotencyKey?: string;
  },
) {
  const { cook, settings } = await loadOpenCateringKitchen(db, input.slug);

  if (input.idempotencyKey) {
    const existing = await db.query.cateringBookings.findFirst({
      where: (t, { eq: e }) => e(t.idempotencyKey, input.idempotencyKey!),
    });
    if (existing) {
      if (existing.customerMobile !== input.customerMobile) {
        throw DomainError.conflict("Duplicate request");
      }
      return { booking: await viewFor(db, existing, "CUSTOMER") };
    }
  }

  const combo = await db.query.cateringCombos.findFirst({
    where: (t, { and: a, eq: e }) =>
      a(e(t.id, input.comboId), e(t.cookId, cook.id), e(t.isActive, true)),
  });
  if (!combo) throw DomainError.notFound("Combo not found");

  const mode = normalizeFulfillmentMode(input.fulfillmentMode);
  const flags = await getFeatureFlags(db);
  const offers = cookFulfillmentOffersFromRow(cook);
  assertFulfillmentAllowed(mode, offers, {
    pickupPlatformAvailable:
      isFeatureEnabled(flags, "pickup_enabled") && Boolean(cook.pickupLandmark?.trim()),
  });

  let deliveryAddress = `Pickup · ${cook.pickupLandmark ?? "kitchen"}`;
  let addressId: number | null = null;
  if (needsCheckoutAddress(mode)) {
    if (!input.addressId) throw new DomainError("Choose a delivery address", 400, "catering_address");
    const addr = await db.query.addresses.findFirst({
      where: (t, { and: a, eq: e }) =>
        a(e(t.id, input.addressId!), e(t.userMobile, input.customerMobile)),
    });
    if (!addr) throw new DomainError("Choose a delivery address from your saved list", 400, "catering_address");
    addressId = addr.id;
    deliveryAddress = [addr.line1, addr.line2, addr.pinCode].filter(Boolean).join(", ");
  }

  const amounts = cateringAmounts({ pricePerPlatePaise: combo.pricePerPlatePaise, plates: input.plates });
  const cutoffAt = cateringCutoffAt(input.eventDate, input.eventTime, settings.cutoffHours);
  await ensureCustomerRow(db, input.customerMobile, cook.pinCode);

  const booking = await db.transaction(async (tx) => {
    await lockKitchenDate(tx, cook.id, input.eventDate);
    assertCateringBookable({
      plates: input.plates,
      minPlates: combo.minPlates,
      maxPlates: combo.maxPlates,
      eventDate: input.eventDate,
      eventTime: input.eventTime,
      cutoffHours: settings.cutoffHours,
      bookedPlatesOnDate: await bookedPlatesOnDate(tx, cook.id, input.eventDate),
      dailyPlateCap: settings.dailyPlateCap,
    });
    const [row] = await tx
      .insert(cateringBookings)
      .values({
        publicId: newCateringPublicId(),
        customerMobile: input.customerMobile,
        cookId: cook.id,
        comboId: combo.id,
        comboName: combo.name,
        comboContents: combo.contents,
        plates: input.plates,
        pricePerPlatePaise: combo.pricePerPlatePaise,
        foodPaise: amounts.foodPaise,
        platformFeePaise: amounts.platformFeePaise,
        advancePaise: amounts.advancePaise,
        balancePaise: amounts.balancePaise,
        eventDate: input.eventDate,
        eventTime: input.eventTime,
        cutoffAt,
        fulfillmentMode: mode,
        addressId,
        deliveryAddress,
        note: input.note?.trim() || null,
        status: "AWAITING_ADVANCE",
        traceId: newTraceId(),
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();
    return row;
  });

  log.info(
    { event: "catering.booking_created", publicId: booking.publicId, cookId: cook.id, plates: booking.plates },
    "catering booking created",
  );

  try {
    await ensureCateringPaymentLink(db, booking);
  } catch (err) {
    // Booking stays AWAITING_ADVANCE; the customer can retry "Pay advance" from the booking page.
    log.warn({ err, event: "catering.link_failed", publicId: booking.publicId }, "advance link failed");
  }
  return { booking: await viewFor(db, booking, "CUSTOMER") };
}

async function loadCustomerBooking(db: Db, publicId: string, customerMobile: string) {
  const b = await db.query.cateringBookings.findFirst({
    where: (t, { eq: e }) => e(t.publicId, publicId),
  });
  if (!b || b.customerMobile !== customerMobile) throw DomainError.notFound("Booking not found");
  return b;
}

export async function getCustomerCateringBooking(db: Db, publicId: string, customerMobile: string) {
  return { booking: await viewFor(db, await loadCustomerBooking(db, publicId, customerMobile), "CUSTOMER") };
}

export async function listCustomerCateringBookings(db: Db, customerMobile: string) {
  const rows = await db.query.cateringBookings.findMany({
    where: (t, { eq: e }) => e(t.customerMobile, customerMobile),
    orderBy: (t, { desc: d }) => [d(t.createdAt)],
    limit: 50,
  });
  const bookings = [];
  for (const b of rows) bookings.push(await viewFor(db, b, "CUSTOMER"));
  return { bookings };
}

/**
 * Returns a live payment link for the phase that is due (advance or balance), creating one if
 * needed. A fresh advance link re-checks the flag, cut-off and capacity (the old hold may be gone).
 */
export async function ensureCateringPaymentLink(db: Db, booking: Booking) {
  const phase = cateringDuePhase(booking.status as CateringStatus);
  if (!phase) throw DomainError.conflict("Nothing to pay on this booking");
  const existing = openLinkFor(await paymentsFor(db, booking.id), phase);
  if (existing) return existing;

  if (phase === "ADVANCE") {
    await assertCateringOn(db);
    const settings = await settingsFor(db, booking.cookId);
    const combo = await db.query.cateringCombos.findFirst({
      where: (t, { eq: e }) => e(t.id, booking.comboId),
    });
    await db.transaction(async (tx) => {
      await lockKitchenDate(tx, booking.cookId, booking.eventDate);
      assertCateringBookable({
        plates: booking.plates,
        minPlates: Math.min(combo?.minPlates ?? booking.plates, booking.plates),
        maxPlates: Math.max(combo?.maxPlates ?? booking.plates, booking.plates),
        eventDate: booking.eventDate,
        eventTime: booking.eventTime,
        // Keep the cut-off promised at booking time.
        cutoffHours: Math.round(
          (cateringEventStartAt(booking.eventDate, booking.eventTime).getTime() -
            booking.cutoffAt.getTime()) /
            3_600_000,
        ),
        bookedPlatesOnDate: await bookedPlatesOnDate(tx, booking.cookId, booking.eventDate, booking.id),
        dailyPlateCap: settings.dailyPlateCap,
      });
      // Refresh the unpaid hold so capacity counts this booking for the new link's lifetime.
      await tx
        .update(cateringBookings)
        .set({ updatedAt: new Date() })
        .where(eq(cateringBookings.id, booking.id));
    });
  }

  const pay = getPaymentProvider();
  const stale = (await paymentsFor(db, booking.id)).filter(
    (p) => p.phase === phase && p.status === "CREATED",
  );
  for (const p of stale) {
    await db
      .update(cateringPayments)
      .set({ status: "SUPERSEDED" })
      .where(and(eq(cateringPayments.id, p.id), eq(cateringPayments.status, "CREATED")));
    if (p.gatewayTxnId) await pay.cancelPaymentLink?.(p.gatewayTxnId).catch(() => undefined);
  }

  const attempt =
    (await paymentsFor(db, booking.id)).filter((p) => p.phase === phase).length + 1;
  const referenceId = `${booking.publicId}-${phase[0]}${attempt}`;
  const idempotencyKey = `cat|${booking.publicId}|${phase}|${attempt}`;
  const amountPaise = phase === "ADVANCE" ? booking.advancePaise : booking.balancePaise;
  const link = await pay.createPayment({
    orderPublicId: booking.publicId,
    referenceId,
    callbackUrl: cateringBookingUrl(booking.publicId),
    amountPaise,
    customerMobile: booking.customerMobile,
    idempotencyKey,
    traceId: booking.traceId,
    notes: { kind: "CATERING", phase },
    expireAtUnix:
      Math.floor(Date.now() / 1000) +
      (phase === "ADVANCE" ? PAYMENT_LINK_TTL_SEC : BALANCE_LINK_TTL_SEC),
  });
  await db
    .insert(cateringPayments)
    .values({
      bookingId: booking.id,
      phase,
      amountPaise,
      status: "CREATED",
      method: "LINK",
      gatewayTxnId: link.gatewayTxnId,
      paymentUrl: link.paymentUrl,
      idempotencyKey,
    })
    .onConflictDoNothing();
  const row = await db.query.cateringPayments.findFirst({
    where: (t, { eq: e }) => e(t.idempotencyKey, idempotencyKey),
  });
  return row!;
}

export async function payCateringBooking(db: Db, publicId: string, customerMobile: string) {
  const b = await loadCustomerBooking(db, publicId, customerMobile);
  const link = await ensureCateringPaymentLink(db, b);
  return {
    paymentUrl: link.paymentUrl!,
    phase: link.phase as CateringPaymentPhase,
    amountPaise: link.amountPaise,
    booking: await viewFor(db, b, "CUSTOMER"),
  };
}

/**
 * After the Razorpay redirect: re-verify open links with the gateway (never trust the client)
 * and record any capture the webhook has not delivered yet.
 */
export async function confirmCateringPayment(db: Db, publicId: string, customerMobile: string) {
  const b = await loadCustomerBooking(db, publicId, customerMobile);
  const pay = getPaymentProvider();
  const pending = (await paymentsFor(db, b.id)).filter(
    (p) => p.phase !== "REFUND" && (p.status === "CREATED" || p.status === "SUPERSEDED") && p.gatewayTxnId,
  );
  if (pay.getPaymentLinkStatus) {
    for (const p of pending) {
      try {
        const live = await pay.getPaymentLinkStatus(p.gatewayTxnId!);
        if (live.status.toLowerCase() !== "paid") continue;
        await markCateringPaymentCaptured(db, {
          gatewayTxnId: p.gatewayTxnId!,
          paymentId: live.paymentId ?? undefined,
          amountPaise: live.amountPaise,
          raw: { source: "confirm-return", linkStatus: live.status },
        });
      } catch (err) {
        log.warn({ err, event: "catering.confirm_failed", publicId }, "catering confirm-return failed");
      }
    }
  }
  return getCustomerCateringBooking(db, publicId, customerMobile);
}

/* ───────────────────────────── Payments ───────────────────────────── */

/** True when a gateway event belongs to catering (CAT- reference / notes.kind). */
export function isCateringGatewayEvent(event: {
  orderPublicId?: string;
  notes?: Record<string, string>;
}) {
  return event.notes?.kind === "CATERING" || Boolean(event.orderPublicId?.startsWith("CAT-"));
}

/**
 * Idempotent capture for an advance/balance link. A capture that no longer matches a due phase
 * (booking cancelled, or the phase was already paid by another link) is refunded automatically.
 */
export async function markCateringPaymentCaptured(
  db: Db,
  input: { gatewayTxnId: string; paymentId?: string; amountPaise?: number; raw?: unknown },
) {
  const payment = await db.query.cateringPayments.findFirst({
    where: (t, { eq: e }) => e(t.gatewayTxnId, input.gatewayTxnId),
  });
  if (!payment || payment.phase === "REFUND") return null;
  if (typeof input.amountPaise === "number" && input.amountPaise > 0 && input.amountPaise !== payment.amountPaise) {
    throw DomainError.conflict("Payment amount does not match booking");
  }

  const outcome = await db.transaction(async (tx) => {
    const [b] = await tx
      .select()
      .from(cateringBookings)
      .where(eq(cateringBookings.id, payment.bookingId))
      .for("update");
    const [claimed] = await tx
      .update(cateringPayments)
      .set({
        status: "PAID",
        paidAt: new Date(),
        paymentId: input.paymentId ?? payment.paymentId,
        rawPayload: (input.raw ?? null) as object | null,
      })
      .where(and(eq(cateringPayments.id, payment.id), ne(cateringPayments.status, "PAID")))
      .returning();
    if (!claimed) return { booking: b, changed: false, orphan: false };

    const due = cateringDuePhase(b.status as CateringStatus);
    if (due !== payment.phase) return { booking: b, changed: false, orphan: true };

    const next: CateringStatus = payment.phase === "ADVANCE" ? "ADVANCE_PAID" : "PAID";
    assertCateringTransition(b.status as CateringStatus, next);
    const [updated] = await tx
      .update(cateringBookings)
      .set({ status: next, updatedAt: new Date() })
      .where(eq(cateringBookings.id, b.id))
      .returning();
    const cook = await tx.query.cookProfiles.findFirst({ where: (t, { eq: e }) => e(t.id, b.cookId) });
    await enqueueOutbox(tx, payment.phase === "ADVANCE" ? "CateringAdvancePaid" : "CateringBalancePaid", {
      ...notifyPayload(updated, cook),
      amountPaise: payment.amountPaise,
    });
    return { booking: updated, changed: true, orphan: false };
  });

  if (outcome.orphan) {
    log.warn(
      { event: "catering.orphan_capture", publicId: outcome.booking.publicId, phase: payment.phase },
      "catering capture after close — auto-refunding",
    );
    await refundCateringPayments(db, outcome.booking, {
      onlyPaymentId: payment.id,
      reason: "paid_after_close",
    });
  }
  return outcome.booking;
}

function notifyPayload(b: Booking, cook?: Pick<Cook, "mobileNumber" | "kitchenName"> | null) {
  return {
    publicId: b.publicId,
    customerMobile: b.customerMobile,
    cookMobile: cook?.mobileNumber ?? null,
    kitchenName: cook?.kitchenName ?? null,
    comboName: b.comboName,
    plates: b.plates,
    eventDate: b.eventDate,
    eventTime: b.eventTime,
    fulfillmentMode: b.fulfillmentMode,
    balancePaise: b.balancePaise,
    totalPaise: totalPaise(b),
    bookingUrl: cateringBookingUrl(b.publicId),
  };
}

/**
 * Refund captured advance/balance payments (newest first) up to `maxPaise` (default: everything
 * not yet refunded). One refund claim per source payment — safe against retries.
 */
async function refundCateringPayments(
  db: Db,
  booking: Booking,
  opts: { maxPaise?: number; onlyPaymentId?: number; reason: string },
) {
  const all = await paymentsFor(db, booking.id);
  const refundedFor = new Set(
    all
      .filter((p) => p.phase === "REFUND")
      .map((p) => Number(String(p.idempotencyKey).split("|")[1])),
  );
  const paid = all
    .filter((p) => p.phase !== "REFUND" && p.status === "PAID" && !refundedFor.has(p.id))
    .filter((p) => !opts.onlyPaymentId || p.id === opts.onlyPaymentId)
    .sort((a, b) => b.id - a.id);
  let remaining = opts.maxPaise ?? paid.reduce((s, p) => s + p.amountPaise, 0);
  let refunded = 0;
  let manualDue = 0;
  const pay = getPaymentProvider();

  for (const p of paid) {
    if (remaining <= 0) break;
    const amount = Math.min(p.amountPaise, remaining);
    const key = `cat-refund|${p.id}`;
    const [claim] = await db
      .insert(cateringPayments)
      .values({
        bookingId: booking.id,
        phase: "REFUND",
        amountPaise: amount,
        status: "PENDING",
        method: p.method,
        idempotencyKey: key,
        rawPayload: { reason: opts.reason, sourcePaymentId: p.id },
      })
      .onConflictDoNothing()
      .returning();
    if (!claim) continue;

    if (p.method === "MANUAL") {
      await db.update(cateringPayments).set({ status: "MANUAL_DUE" }).where(eq(cateringPayments.id, claim.id));
      manualDue += amount;
      remaining -= amount;
      continue;
    }
    try {
      const paymentId =
        p.paymentId ?? (p.gatewayTxnId ? await pay.resolvePaymentId(p.gatewayTxnId) : null);
      if (!paymentId) throw new Error("No gateway payment id to refund");
      const r = await pay.refundPayment({
        paymentId,
        amountPaise: amount,
        receipt: `${booking.publicId}-R${p.id}`.slice(0, 40),
        notes: { orderPublicId: booking.publicId, kind: "CATERING", reason: opts.reason },
      });
      await db
        .update(cateringPayments)
        .set({ status: "REFUNDED", gatewayTxnId: r.refundId, paymentId, paidAt: new Date() })
        .where(eq(cateringPayments.id, claim.id));
      refunded += amount;
      remaining -= amount;
    } catch (err) {
      log.error({ err, event: "catering.refund_failed", publicId: booking.publicId }, "catering refund failed");
      await db
        .update(cateringPayments)
        .set({ status: "REFUND_FAILED", rawPayload: { reason: opts.reason, error: String(err) } })
        .where(eq(cateringPayments.id, claim.id));
    }
  }

  if (refunded + manualDue > 0) {
    await db
      .update(cateringBookings)
      .set({
        refundedPaise: sql`${cateringBookings.refundedPaise} + ${refunded + manualDue}`,
        updatedAt: new Date(),
      })
      .where(eq(cateringBookings.id, booking.id));
  }
  return { refundedPaise: refunded, manualRefundDuePaise: manualDue };
}

/* ───────────────────────────── Cancel ───────────────────────────── */

export async function cancelCateringBooking(
  db: Db,
  input: {
    publicId: string;
    by: "CUSTOMER" | "COOK" | "ADMIN";
    customerMobile?: string;
    cookSlug?: string;
    actor?: string;
    reason?: string | null;
    /** Admin only: refund less than everything paid (e.g. ingredients already bought). */
    refundPaise?: number;
  },
) {
  const b = await db.query.cateringBookings.findFirst({
    where: (t, { eq: e }) => e(t.publicId, input.publicId),
  });
  if (!b) throw DomainError.notFound("Booking not found");
  const cook = await db.query.cookProfiles.findFirst({ where: (t, { eq: e }) => e(t.id, b.cookId) });

  if (input.by === "CUSTOMER") {
    if (b.customerMobile !== input.customerMobile) throw DomainError.notFound("Booking not found");
    if (!customerCanCancelCatering(b.status as CateringStatus, b.cutoffAt)) {
      throw DomainError.conflict(
        "The cancellation window has closed — contact support and the kitchen for help",
      );
    }
  }
  if (input.by === "COOK" && cook?.slugHandle !== input.cookSlug) {
    throw DomainError.notFound("Booking not found");
  }
  assertCateringTransition(b.status as CateringStatus, "CANCELLED");

  const [cancelled] = await db
    .update(cateringBookings)
    .set({
      status: "CANCELLED",
      cancelledBy: input.by,
      cancelReason: input.reason?.trim().slice(0, 300) || null,
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(cateringBookings.id, b.id), eq(cateringBookings.status, b.status)))
    .returning();
  if (!cancelled) throw DomainError.conflict("Booking changed — refresh and try again");

  const pay = getPaymentProvider();
  for (const p of await paymentsFor(db, b.id)) {
    if (p.status === "CREATED") {
      await db.update(cateringPayments).set({ status: "SUPERSEDED" }).where(eq(cateringPayments.id, p.id));
      if (p.gatewayTxnId) await pay.cancelPaymentLink?.(p.gatewayTxnId).catch(() => undefined);
    }
  }

  const refund = await refundCateringPayments(db, cancelled, {
    maxPaise: input.by === "ADMIN" ? input.refundPaise : undefined,
    reason: `cancelled_by_${input.by.toLowerCase()}`,
  });

  if (input.by === "ADMIN") {
    await db.insert(adminActionLog).values({
      actor: input.actor ?? "admin",
      action: "CATERING_CANCEL",
      entityType: "catering_booking",
      entityId: b.publicId,
      reason: input.reason ?? null,
      payload: { ...refund, requestedRefundPaise: input.refundPaise ?? null },
    });
  }
  const wasPaid = PAID_LIKE.includes(b.status as CateringStatus);
  if (wasPaid) {
    await enqueueOutbox(db, "CateringCancelled", {
      ...notifyPayload(cancelled, cook),
      cancelledBy: input.by,
      refundPaise: refund.refundedPaise + refund.manualRefundDuePaise,
    });
  }
  const fresh = await db.query.cateringBookings.findFirst({ where: (t, { eq: e }) => e(t.id, b.id) });
  return {
    booking: await viewFor(db, fresh!, input.by),
    ...refund,
  };
}

/* ───────────────────────────── Admin / jobs ───────────────────────────── */

export async function listCateringBookingsAdmin(
  db: Db,
  opts: { status?: CateringStatus; limit?: number } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const rows = await db
    .select()
    .from(cateringBookings)
    .where(opts.status ? eq(cateringBookings.status, opts.status) : undefined)
    .orderBy(desc(cateringBookings.eventDate), desc(cateringBookings.id))
    .limit(limit);
  const bookings = [];
  for (const b of rows) bookings.push(await viewFor(db, b, "ADMIN"));
  return { platformEnabled: await cateringPlatformEnabled(db), bookings };
}

/** Admin records a due phase paid outside the gateway (cash / direct UPI on event day). */
export async function adminRecordCateringPayment(
  db: Db,
  publicId: string,
  input: { reference: string; actor?: string },
) {
  const b = await db.query.cateringBookings.findFirst({ where: (t, { eq: e }) => e(t.publicId, publicId) });
  if (!b) throw DomainError.notFound("Booking not found");
  const phase = cateringDuePhase(b.status as CateringStatus);
  if (!phase) throw DomainError.conflict("Nothing is due on this booking");
  const idempotencyKey = `cat|${publicId}|${phase}|manual`;
  const gatewayTxnId = `manual_${publicId}_${phase}`;
  await db
    .insert(cateringPayments)
    .values({
      bookingId: b.id,
      phase,
      amountPaise: phase === "ADVANCE" ? b.advancePaise : b.balancePaise,
      status: "CREATED",
      method: "MANUAL",
      gatewayTxnId,
      idempotencyKey,
    })
    .onConflictDoNothing();
  await markCateringPaymentCaptured(db, {
    gatewayTxnId,
    raw: { source: "admin_manual", reference: input.reference, actor: input.actor ?? "admin" },
  });
  await db.insert(adminActionLog).values({
    actor: input.actor ?? "admin",
    action: "CATERING_MANUAL_PAYMENT",
    entityType: "catering_booking",
    entityId: publicId,
    reason: input.reference,
    payload: { phase },
  });
  const fresh = await db.query.cateringBookings.findFirst({ where: (t, { eq: e }) => e(t.id, b.id) });
  return { booking: await viewFor(db, fresh!, "ADMIN") };
}

/** Admin marks the cook's food share as paid out (manual UPI/NEFT, outside lunch EOD batches). */
export async function adminMarkCateringCookPaid(
  db: Db,
  publicId: string,
  input: { utr: string; actor?: string },
) {
  const [row] = await db
    .update(cateringBookings)
    .set({ cookPaidAt: new Date(), cookPaidUtr: input.utr.trim().slice(0, 80), updatedAt: new Date() })
    .where(and(eq(cateringBookings.publicId, publicId), eq(cateringBookings.status, "COMPLETED")))
    .returning();
  if (!row) throw DomainError.conflict("Only completed bookings can be marked as paid to the cook");
  await db.insert(adminActionLog).values({
    actor: input.actor ?? "admin",
    action: "CATERING_COOK_PAID",
    entityType: "catering_booking",
    entityId: publicId,
    reason: input.utr,
    payload: { foodPaise: row.foodPaise },
  });
  return { booking: await viewFor(db, row, "ADMIN") };
}

/** One WhatsApp balance reminder per booking once the event is ≤48h away. Idempotent. */
export async function sendCateringBalanceReminders(db: Db, now = new Date()) {
  const rows = await db.query.cateringBookings.findMany({
    where: (t, { and: a, eq: e, isNull, lte }) =>
      a(
        e(t.status, "ADVANCE_PAID"),
        isNull(t.balanceRemindedAt),
        lte(t.eventDate, addDaysISO(serviceDateISO(now), 2)),
      ),
    limit: 200,
  });
  let reminded = 0;
  for (const b of rows) {
    const startsAt = cateringEventStartAt(b.eventDate, b.eventTime).getTime();
    if (startsAt - now.getTime() > BALANCE_REMINDER_HOURS * 3_600_000) continue;
    await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(cateringBookings)
        .set({ balanceRemindedAt: now })
        .where(and(eq(cateringBookings.id, b.id), sql`${cateringBookings.balanceRemindedAt} is null`))
        .returning();
      if (!claimed) return;
      const cook = await tx.query.cookProfiles.findFirst({ where: (t, { eq: e }) => e(t.id, b.cookId) });
      await enqueueOutbox(tx, "CateringBalanceDue", notifyPayload(claimed, cook));
      reminded += 1;
    });
  }
  return { ok: true as const, reminded };
}
