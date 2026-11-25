import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import {
  Count,
  FulfillmentMode,
  Id,
  IdParam,
  IsoDate,
  IsoDateTime,
  Paise,
  Slug,
  Text,
  Url,
} from "../openapi/shared.js";

const TAGS = ["Catering (MVP-3)"];

/* ───────────── Shared ───────────── */

export const CateringPublicId = z
  .string()
  .min(5)
  .max(20)
  .regex(/^CAT-[A-Za-z0-9]{1,16}$/)
  .describe("Party booking id, e.g. CAT-0F3A9B2C1D");
const CateringStatus = z
  .enum(["AWAITING_ADVANCE", "ADVANCE_PAID", "PAID", "COMPLETED", "CANCELLED"])
  .describe("Party booking lifecycle");
const Phase = z.enum(["ADVANCE", "BALANCE"]).describe("Which half is being paid");
const EventTime = z
  .string()
  .length(5)
  .regex(/^\d{2}:\d{2}$/)
  .describe("Event start HH:MM (Asia/Kolkata, 06:00–22:59)");
const Plates = z.number().int().min(1).max(150).describe("Plates");
const Hours = z.number().int().min(48).max(72).describe("Cut-off hours before event start");

export const SlugParams = z.object({ slug: Slug });
export const SlugComboParams = z.object({ slug: Slug, id: IdParam });
export const BookingParams = z.object({ publicId: CateringPublicId });
export const SlugBookingParams = z.object({ slug: Slug, publicId: CateringPublicId });

const Combo = z.object({
  id: Id,
  name: Text(100),
  nameTa: Text(100).nullable(),
  contents: Text(500).nullable(),
  pricePerPlatePaise: Paise,
  minPlates: Plates,
  maxPlates: Plates,
  isVeg: z.boolean(),
  imageUrl: Url.nullable(),
  isActive: z.boolean(),
});

const Booking = z.object({
  publicId: CateringPublicId,
  status: CateringStatus,
  kitchenSlug: Text(50),
  kitchenName: Text(100),
  comboId: Id,
  comboName: Text(100),
  comboContents: Text(500).nullable(),
  plates: Plates,
  pricePerPlatePaise: Paise,
  foodPaise: Paise,
  platformFeePaise: Paise,
  totalPaise: Paise,
  advancePaise: Paise,
  balancePaise: Paise,
  paidPaise: Paise,
  refundedPaise: Paise,
  eventDate: IsoDate,
  eventTime: EventTime,
  cutoffAt: IsoDateTime,
  fulfillmentMode: FulfillmentMode,
  note: Text(500).nullable(),
  duePhase: Phase.nullable(),
  duePaise: Paise,
  paymentUrl: Url.nullable(),
  canCustomerCancel: z.boolean(),
  cancelledBy: Text(20).nullable(),
  cancelReason: Text(300).nullable(),
  createdAt: IsoDateTime,
  deliveryAddress: Text(1000).nullable().describe("Shown to the cook only after the advance is paid"),
  pickupLandmark: Text(300).nullable().describe("Pickup only, after the advance is paid"),
  customerMobile: Text(15).nullable().describe("Shown to the cook only after the advance is paid"),
});

const AdminBooking = Booking.extend({
  commissionBps: z.number().int().min(0).max(10_000).describe("Commission snapshot (basis points of food)"),
  commissionPaise: Paise.describe("Platform commission on food"),
  cookPayoutPaise: Paise.describe("Food minus commission — what to pay the cook"),
  cookPaidAt: IsoDateTime.nullable(),
  cookPaidUtr: Text(80).nullable(),
  payments: z
    .array(
      z.object({
        id: Id,
        phase: z.enum(["ADVANCE", "BALANCE", "REFUND"]),
        amountPaise: Paise,
        status: Text(20),
        method: Text(16),
        gatewayTxnId: Text(100).nullable(),
        paymentId: Text(100).nullable(),
        createdAt: IsoDateTime,
        paidAt: IsoDateTime.nullable(),
      }),
    )
    .max(50),
});

const Settings = z.object({
  enabled: z.boolean(),
  cutoffHours: Hours,
  dailyPlateCap: z.number().int().min(10).max(450),
});

/* ───────────── Requests ───────────── */

export const SettingsBody = z
  .object({
    enabled: z.boolean().optional(),
    cutoffHours: Hours.optional(),
    dailyPlateCap: z.number().int().min(10).max(450).optional(),
  })
  .describe("Cook catering opt-in and bounds");

export const ComboBody = z
  .object({
    name: z.string().min(2).max(100),
    nameTa: z.string().max(100).nullable().optional(),
    contents: z.string().max(500).nullable().optional().describe("Plate contents shown to customers"),
    pricePerPlatePaise: z.number().int().min(100).max(10_000_000),
    minPlates: z.number().int().min(10).max(150),
    maxPlates: z.number().int().min(10).max(150),
    isVeg: z.boolean().optional(),
    imageUrl: Url.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .describe("Party combo (per-plate price + MOQ)");

export const CreateBookingBody = z
  .object({
    slug: Slug,
    comboId: Id,
    plates: Plates,
    eventDate: IsoDate,
    eventTime: EventTime,
    fulfillmentMode: FulfillmentMode.optional(),
    addressId: Id.optional().describe("Saved address (DELIVERY / CUSTOMER_ARRANGE)"),
    note: z.string().max(500).nullable().optional().describe("Occasion / instructions for the cook"),
    idempotencyKey: z.string().min(8).max(120).optional().describe("Client retry key"),
  })
  .describe("Book a party combo — returns the advance payment link");

const NoBody = z.object({}).describe("No body fields");
export const CancelBody = z.object({ reason: z.string().max(300).nullable().optional() });
export const AdminCancelBody = z.object({
  reason: z.string().min(3).max(300),
  refundPaise: Paise.optional().describe("Refund less than everything paid (default: all)"),
});
export const ManualPaymentBody = z.object({
  reference: z.string().min(3).max(120).describe("Cash / UPI reference recorded by ops"),
});
export const CookPaidBody = z.object({ utr: z.string().min(4).max(80) });
export const AdminListQuery = z.object({
  status: CateringStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/* ───────────── Responses ───────────── */

const PublicKitchen = z.object({
  kitchenSlug: Text(50),
  kitchenName: Text(100),
  pinCode: Text(6),
  cutoffHours: Hours,
  platformFeePaise: Paise.describe("Admin-set platform fee per booking, charged with the advance"),
  earliestEventDate: IsoDate,
  latestEventDate: IsoDate,
  fulfillment: z.object({ cookDelivery: z.boolean(), pickup: z.boolean(), customerArrange: z.boolean() }),
  combos: z.array(Combo).max(100),
});

const Desk = z.object({
  platformEnabled: z.boolean(),
  kitchenLive: z.boolean(),
  settings: Settings,
  limits: z.object({
    minMoq: Count,
    maxPlates: Count,
    cutoffHoursMin: Count,
    cutoffHoursMax: Count,
  }),
  combos: z.array(Combo).max(100),
  bookings: z.array(Booking).max(100),
});

const BookingOut = z.object({ booking: Booking });
const CancelOut = z.object({
  booking: Booking,
  refundedPaise: Paise,
  manualRefundDuePaise: Paise,
});

export const cateringOperations = defineOperations([
  {
    method: "get",
    path: "/kitchens/:slug/catering",
    operationId: "getKitchenCatering",
    summary: "Party combos for a kitchen (404 unless catering_enabled + cook opted in)",
    tags: TAGS,
    access: "public",
    params: SlugParams,
    response: PublicKitchen,
  },
  {
    method: "post",
    path: "/catering/bookings",
    operationId: "createCateringBooking",
    summary: "Book a party combo (MOQ, cut-off, capacity checked) and get the 50% advance link",
    tags: TAGS,
    access: "customer",
    body: CreateBookingBody,
    response: BookingOut,
    errors: { 404: "Catering off / combo not found", 409: "Kitchen fully booked for that date" },
  },
  {
    method: "get",
    path: "/me/catering/bookings",
    operationId: "listMyCateringBookings",
    summary: "Signed-in customer's party bookings",
    tags: TAGS,
    access: "customer",
    response: z.object({ bookings: z.array(Booking).max(50) }),
  },
  {
    method: "get",
    path: "/catering/bookings/:publicId",
    operationId: "getCateringBooking",
    summary: "One party booking (owner only)",
    tags: TAGS,
    access: "customer",
    params: BookingParams,
    response: BookingOut,
    errors: { 404: "Booking not found" },
  },
  {
    method: "post",
    path: "/catering/bookings/:publicId/pay",
    operationId: "payCateringBooking",
    summary: "Payment link for whatever is due (advance or balance); re-issues expired links",
    tags: TAGS,
    access: "customer",
    params: BookingParams,
    body: NoBody,
    response: z.object({ paymentUrl: Url, phase: Phase, amountPaise: Paise, booking: Booking }),
    errors: { 404: "Booking not found", 409: "Nothing due / kitchen full" },
  },
  {
    method: "post",
    path: "/catering/bookings/:publicId/confirm",
    operationId: "confirmCateringPayment",
    summary: "After the gateway redirect: re-verify open links with Razorpay and record captures",
    tags: TAGS,
    access: "customer",
    params: BookingParams,
    body: NoBody,
    response: BookingOut,
    errors: { 404: "Booking not found" },
  },
  {
    method: "post",
    path: "/catering/bookings/:publicId/cancel",
    operationId: "cancelCateringBooking",
    summary: "Customer cancel — free before the advance, full refund until the cut-off",
    tags: TAGS,
    access: "customer",
    params: BookingParams,
    body: CancelBody,
    response: CancelOut,
    errors: { 404: "Booking not found", 409: "Cancellation window closed" },
  },
  {
    method: "get",
    path: "/cooks/:slug/catering",
    operationId: "getCookCateringDesk",
    summary: "Cook desk: catering settings, combos and upcoming party bookings",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    response: Desk,
  },
  {
    method: "patch",
    path: "/cooks/:slug/catering/settings",
    operationId: "updateCookCateringSettings",
    summary: "Opt in/out of party orders, set cut-off (48–72h) and daily plate cap",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: SettingsBody,
    response: z.object({ settings: Settings }),
    errors: { 404: "Catering off" },
  },
  {
    method: "post",
    path: "/cooks/:slug/catering/combos",
    operationId: "createCateringCombo",
    summary: "Create a party combo",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: ComboBody,
    response: z.object({ combo: Combo }),
    errors: { 404: "Catering off", 409: "Duplicate name" },
  },
  {
    method: "put",
    path: "/cooks/:slug/catering/combos/:id",
    operationId: "updateCateringCombo",
    summary: "Replace a party combo (set isActive=false to hide it)",
    tags: TAGS,
    access: "cook",
    params: SlugComboParams,
    body: ComboBody,
    response: z.object({ combo: Combo }),
    errors: { 404: "Combo not found / catering off" },
  },
  {
    method: "post",
    path: "/cooks/:slug/catering/bookings/:publicId/complete",
    operationId: "completeCateringBooking",
    summary: "Mark a fully paid party order delivered / collected",
    tags: TAGS,
    access: "cook",
    params: SlugBookingParams,
    body: NoBody,
    response: BookingOut,
    errors: { 404: "Booking not found", 409: "Balance still due" },
  },
  {
    method: "post",
    path: "/cooks/:slug/catering/bookings/:publicId/cancel",
    operationId: "cookCancelCateringBooking",
    summary: "Cook cancels a party order — customer is refunded everything paid",
    tags: TAGS,
    access: "cook",
    params: SlugBookingParams,
    body: CancelBody,
    response: CancelOut,
    errors: { 404: "Booking not found", 409: "Already closed" },
  },
  {
    method: "get",
    path: "/admin/catering/bookings",
    operationId: "adminListCateringBookings",
    summary: "Party bookings with advance/balance/refund payment rows",
    tags: TAGS,
    access: "admin",
    query: AdminListQuery,
    response: z.object({ platformEnabled: z.boolean(), bookings: z.array(AdminBooking).max(100) }),
  },
  {
    method: "post",
    path: "/admin/catering/bookings/:publicId/cancel",
    operationId: "adminCancelCateringBooking",
    summary: "Cancel any open party booking with a full or partial refund",
    tags: TAGS,
    access: "admin",
    params: BookingParams,
    body: AdminCancelBody,
    response: z.object({ booking: AdminBooking, refundedPaise: Paise, manualRefundDuePaise: Paise }),
    errors: { 404: "Booking not found", 409: "Already closed" },
  },
  {
    method: "post",
    path: "/admin/catering/bookings/:publicId/manual-payment",
    operationId: "adminRecordCateringPayment",
    summary: "Record the due advance/balance as paid outside the gateway (cash / direct UPI)",
    tags: TAGS,
    access: "admin",
    params: BookingParams,
    body: ManualPaymentBody,
    response: z.object({ booking: AdminBooking }),
    errors: { 404: "Booking not found", 409: "Nothing due" },
  },
  {
    method: "post",
    path: "/admin/catering/bookings/:publicId/cook-paid",
    operationId: "adminMarkCateringCookPaid",
    summary: "Mark the cook's food share paid out (manual UPI/NEFT)",
    tags: TAGS,
    access: "admin",
    params: BookingParams,
    body: CookPaidBody,
    response: z.object({ booking: AdminBooking }),
    errors: { 409: "Booking not completed" },
  },
  {
    method: "post",
    path: "/internal/catering/balance-reminders",
    operationId: "runCateringBalanceReminders",
    summary: "Scheduler: one WhatsApp balance reminder per booking ≤48h before the event",
    tags: TAGS,
    access: "internal",
    body: NoBody,
    response: z.object({ ok: z.literal(true), reminded: Count }),
  },
]);
