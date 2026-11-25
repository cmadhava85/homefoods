/**
 * Response building blocks shared by the admin / internal / payment / webhook contracts.
 * Row schemas mirror packages/db/src/schema.ts (lengths + nullability); timestamps are ISO strings.
 */
import { z } from "zod";
import { Count, Id, IsoDate, IsoDateTime, MealType, OrderStatus, Paise, Spice, Text, Url, Uuid } from "../openapi/shared.js";

export const Timestamp = IsoDateTime;
/** Stored mobile (varchar 15, +91…); may be redacted by retention. */
export const StoredMobile = z.string().max(20).describe("Mobile number, e.g. +919876543210");
/** Aggregate paise (sums across many orders / a year). */
export const PaiseTotal = z.number().int().min(0).max(10_000_000_000_000).describe("Aggregate amount in paise");
export const BigId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe("Numeric id (bigserial)");
const Hour = z.number().int().min(0).max(23);
const Minute = z.number().int().min(0).max(59);
const Percent = z.number().int().min(0).max(100);
/** Basis points (1% = 100). */
export const Bps = z.number().int().min(0).max(10_000).describe("Basis points (1% = 100)");
/** Postgres numeric(…) columns arrive as decimal strings. */
const Decimal = z.string().max(20).regex(/^-?\d+(\.\d+)?$/).describe("Decimal string");

const JsonKey = z.string().max(100);
const JsonScalar = z.union([
  z.string().max(4000),
  z.number().min(-1e15).max(1e15),
  z.boolean(),
  z.null(),
]);
const JsonL3 = z.union([JsonScalar, z.array(JsonScalar).max(100), z.record(JsonKey, JsonScalar)]);
const JsonL2 = z.union([JsonScalar, z.array(JsonL3).max(100), z.record(JsonKey, JsonL3)]);
const JsonL1 = z.union([JsonScalar, z.array(JsonL2).max(100), z.record(JsonKey, JsonL2)]);
/** Any JSON value (bounded depth). */
export const JsonValue = JsonL1;
/** Free-form JSON object (jsonb payloads, provider events) — bounded to 4 levels. */
export const JsonObject = z.record(JsonKey, JsonL1).describe("JSON object (bounded depth)");

export const ChannelEnum = z.enum(["VOICE_IVR", "WHATSAPP_BOT", "WEB_STOREFRONT", "SYSTEM_CRON", "ADMIN"]);
export const OnboardingStatus = z.enum(["DRAFT", "DOCS_SUBMITTED", "GATEWAY_KYC_PENDING", "LIVE", "REJECTED"]);
export const LogisticsMode = z.enum(["SELF", "PARTNER"]);
export const TicketCategory = z.enum([
  "MISSING_DELIVERY",
  "QUALITY",
  "WRONG_ITEM",
  "PAYMENT",
  "FOODBORNE",
  "COOK_OPS",
  "DELAY",
  "DOOR_NO_ANSWER",
  "OTHER",
]);
export const TicketStatus = z.enum(["OPEN", "RESOLVED", "CLOSED"]);
export const PaymentMethod = z.enum(["LINK", "UPI_QR", "CREDIT"]).describe("How the order is paid");
export const AdType = z.enum(["KITCHEN_BOOST", "EXTERNAL"]);
export const AdStatus = z.enum(["DRAFT", "ACTIVE", "PAUSED", "ENDED"]);

/** Full `orders` row. */
export const OrderRow = z
  .object({
    id: Id,
    publicId: Text(20),
    customerMobile: StoredMobile,
    payerMobile: StoredMobile.nullable(),
    cookId: Uuid,
    menuItemId: Id.nullable(),
    addressId: Id.nullable(),
    mealType: MealType,
    serviceDate: IsoDate,
    itemName: Text(100),
    itemNameTa: Text(100).nullable(),
    qty: Count,
    spice: Spice,
    foodPaise: Paise,
    foodDiscountPaise: Paise,
    weekDiscountPercent: Percent.nullable(),
    deliveryPaise: Paise,
    platformFeePaise: Paise,
    commissionBps: Bps.describe("Cook commission snapshot taken at EOD"),
    convenienceFeePaise: Paise,
    creditAppliedPaise: Paise,
    paymentMethod: PaymentMethod,
    status: OrderStatus,
    settlementHold: z.boolean(),
    settlementId: Id.nullable(),
    fulfillmentMode: Text(16),
    logisticsMode: LogisticsMode,
    partnerShipmentId: Text(100).nullable(),
    partnerTrackingUrl: Url.nullable(),
    deliveryTargetAddress: Text(2000),
    channel: ChannelEnum,
    checkoutId: Text(20).nullable(),
    traceId: Text(40),
    gatewayTxnId: Text(100).nullable(),
    idempotencyKey: Text(160).nullable(),
    routeMapsUrl: Text(8000).nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .describe("Order line");

/** markOrderPaid result: first line + all lines of the checkout. */
export const PaidOrder = OrderRow.extend({
  orders: z.array(OrderRow).max(31),
  paidAfterTerminal: z.literal(true).optional().describe("Captured after every line was cancelled (auto-refunded)"),
  autoRefundId: Text(100).nullable().optional(),
}).describe("Paid order (first line) with all checkout lines");

/** Full `cook_profiles` row. */
export const CookProfileRow = z
  .object({
    id: Uuid,
    mobileNumber: StoredMobile,
    kitchenName: Text(100),
    slugHandle: Text(50),
    lat: Decimal.nullable(),
    lng: Decimal.nullable(),
    pinCode: Text(6),
    deliveryType: LogisticsMode,
    flatSelfDeliveryFee: Decimal,
    maxSelfDistanceKm: Decimal,
    maxDailyCapacity: Count,
    lunchCutoffHour: Hour,
    lunchCutoffMinute: Minute,
    deliveryWindowStartHour: Hour,
    deliveryWindowStartMinute: Minute,
    deliveryWindowEndHour: Hour,
    deliveryWindowEndMinute: Minute,
    isActive: z.boolean(),
    onboardingStatus: OnboardingStatus,
    fssaiNumber: Text(32).nullable(),
    fssaiVerifiedAt: Timestamp.nullable(),
    payoutBeneficiaryRef: Text(80).nullable(),
    payoutUpiId: Text(80).nullable(),
    payoutAccountNote: Text(2000).nullable(),
    weekDiscountPercent: Percent,
    weekDiscountMinDays: z.number().int().min(0).max(31),
    pickupLandmark: Text(2000).nullable(),
    pickupEnabled: z.boolean(),
    intakePausedDate: Text(10).nullable(),
    lateOrdersEnabled: z.boolean(),
    offerCookDelivery: z.boolean(),
    offerCustomerArrange: z.boolean(),
    commissionBps: Bps.nullable().describe("Per-cook commission override (null = platform default)"),
    createdAt: Timestamp,
  })
  .describe("Cook profile");

/** Full `settlements` row. */
export const SettlementRow = z
  .object({
    id: Id,
    cookId: Uuid,
    businessDate: IsoDate,
    grossPaise: PaiseTotal,
    feesPaise: PaiseTotal,
    clawbackPaise: PaiseTotal,
    netPaise: PaiseTotal,
    orderCount: Count,
    gatewayBatchId: Text(100).nullable(),
    status: Text(32),
    manualPaidAt: Timestamp.nullable(),
    manualUtr: Text(80).nullable(),
    manualNote: Text(2000).nullable(),
    createdAt: Timestamp,
  })
  .describe("Cook settlement (one per cook per business date)");

/** Full `support_tickets` row. */
export const SupportTicketRow = z
  .object({
    id: Id,
    orderId: Id.nullable(),
    cookId: Uuid.nullable(),
    customerMobile: StoredMobile.nullable(),
    category: TicketCategory,
    status: TicketStatus,
    source: Text(40),
    summary: Text(4000),
    photoUrl: Url.nullable(),
    decision: Text(40).nullable(),
    slaDueAt: Timestamp.nullable(),
    createdAt: Timestamp,
    resolvedAt: Timestamp.nullable(),
  })
  .describe("Support ticket");

export const AdCampaign = z
  .object({
    id: Id,
    type: AdType,
    status: AdStatus,
    pinCode: Text(6),
    cookId: Uuid.nullable(),
    cookSlug: Text(50).nullable(),
    kitchenName: Text(100).nullable(),
    title: Text(120),
    body: Text(2000).nullable(),
    ctaUrl: Text(500).nullable(),
    imageUrl: Text(500).nullable(),
    priority: z.number().int().min(-2_147_483_648).max(2_147_483_647),
    startsAt: Timestamp.nullable(),
    endsAt: Timestamp.nullable(),
    createdBy: Text(80).nullable(),
    createdAt: Timestamp,
  })
  .describe("Ad campaign");
