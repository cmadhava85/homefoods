import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import {
  CheckoutId,
  Count,
  FulfillmentMode,
  Id,
  IdParam,
  IsoDate,
  IsoDateTime,
  MealType,
  OrderPublicId,
  OrderStatus,
  Paise,
  PinCode,
  Qty,
  Slug,
  Spice,
  Text,
  Url,
  Uuid,
} from "../openapi/shared.js";

// ---------------------------------------------------------------------------
// Request schemas (parsed by customerRoutes.ts)
// ---------------------------------------------------------------------------

const MobileInput = z.string().max(20).describe("Mobile number (normalised server-side)");
const Channel = z.enum(["WEB_STOREFRONT", "WHATSAPP_BOT"]).describe("Ordering channel");
/** Query-string meal: invalid values fall back to LUNCH in the handler. */
const MealQuery = z.string().max(20).optional().describe("BREAKFAST | LUNCH | DINNER (default LUNCH)");
const DaysQuery = z
  .string()
  .max(3)
  .regex(/^\d*$/)
  .optional()
  .describe("Number of calendar days (default 7, max 14)");
const LatLng = z
  .union([z.string().max(32), z.number().min(-180).max(180)])
  .optional()
  .nullable()
  .describe("Device GPS coordinate (PIN-anchored server-side)");

export const SlugParams = z.object({ slug: Slug });
export const PublicIdParams = z.object({ publicId: OrderPublicId });
export const CheckoutIdParams = z.object({ checkoutId: CheckoutId });
export const IdParams = z.object({ id: IdParam });

export const KitchensQuery = z.object({
  pin: z.string().max(10).optional().describe("Filter by PIN code (blank = all)"),
});
export const AdsQuery = z.object({ pin: PinCode });
export const KitchenMenuQuery = z.object({
  date: IsoDate.optional(),
  meal: MealQuery,
});
export const KitchenMealsQuery = z.object({ days: DaysQuery });
export const KitchenWeekQuery = z.object({
  from: IsoDate.optional().describe("First service date (default today)"),
  days: DaysQuery,
  meal: MealQuery,
});
export const MyOrdersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).optional(),
});

export const ProfilePatchBody = z
  .object({
    fullName: z.string().min(2).max(80).optional(),
    pinCode: z.string().min(6).max(6).optional(),
    preferredLanguage: z.enum(["en", "ta"]).optional(),
    leanWaStatus: z.boolean().optional(),
  })
  .describe("Profile fields to update");

export const AddressCreateBody = z
  .object({
    label: z.enum(["HOME", "OFFICE", "OTHER"]),
    line1: z.string().min(5).max(300),
    line2: z.string().max(300).optional().nullable(),
    pinCode: z.string().min(6).max(6),
    lat: LatLng,
    lng: LatLng,
    isDefault: z.boolean().optional(),
  })
  .describe("New saved address (one per label)");

export const AddressPatchBody = z
  .object({
    line1: z.string().min(5).max(300).optional(),
    line2: z.string().max(300).optional().nullable(),
    pinCode: z.string().min(6).max(6).optional(),
    lat: LatLng,
    lng: LatLng,
    isDefault: z.boolean().optional(),
  })
  .describe("Address fields to update");

const OrderLineInput = {
  customerMobile: MobileInput.describe("Ignored — the signed-in customer's mobile is used"),
  cookSlug: z.string().max(50).describe("Kitchen slug"),
  menuItemId: Id,
  qty: Qty.default(1),
  spice: Spice.default("NORMAL"),
  channel: Channel.optional(),
  serviceDate: IsoDate.optional(),
  fulfillmentMode: FulfillmentMode.optional(),
  payerMobile: MobileInput.optional().nullable().describe("Child Pays: active family payer"),
  addressId: Id.optional().nullable().describe("Saved address id (required for web delivery)"),
};

const CheckoutPayInput = {
  useCredit: z.boolean().optional().describe("Spend LocalMeals credit first (default true)"),
  paymentMethod: z
    .enum(["LINK", "UPI_QR"])
    .optional()
    .describe("UPI_QR (lower fee) only for PICKUP when enabled; otherwise a payment link"),
};

export const CreateOrderBody = z.object({ ...OrderLineInput, ...CheckoutPayInput }).describe("Single-day order");
export const LateOrderBody = z.object(OrderLineInput).describe("After cut-off request (cook approves before pay)");

export const CreateOrderBatchBody = z
  .object({
    customerMobile: OrderLineInput.customerMobile,
    cookSlug: OrderLineInput.cookSlug,
    channel: Channel.optional(),
    payerMobile: OrderLineInput.payerMobile,
    fulfillmentMode: FulfillmentMode.optional(),
    addressId: OrderLineInput.addressId,
    ...CheckoutPayInput,
    lines: z
      .array(
        z.object({
          menuItemId: Id,
          serviceDate: IsoDate,
          qty: Qty.default(1),
          spice: Spice.default("NORMAL"),
        }),
      )
      .min(1)
      // Up to 14 calendar days × breakfast/lunch/dinner (matches createOrderBatch).
      .max(42),
  })
  .describe("Week cart: several service days, one payment");

export const FamilyLinkBody = z
  .object({ payerMobile: z.string().min(10).max(20).describe("Payer (child) mobile") })
  .describe("Invite a family payer");

export const DeclineReasonBody = z
  .object({ reason: z.string().max(500).optional() })
  .describe("Optional reason shown to the customer");

export const FollowBody = z
  .object({ consent: z.boolean().optional().describe("Must be true to opt in to WhatsApp menu alerts") })
  .describe("Follow a kitchen");

export const ConcernBody = z
  .object({
    category: z.enum([
      "QUALITY",
      "FOODBORNE",
      "WRONG_ITEM",
      "MISSING_DELIVERY",
      "DELAY",
      "PAYMENT",
      "OTHER",
    ]),
    summary: z.string().min(10).max(2000),
    photoUrl: z.string().max(200).nullable().optional().describe("URL returned by …/concern/photo"),
  })
  .describe("Customer concern on an order");

export const ReviewBody = z
  .object({
    rating: z.number().int().min(1).max(5),
    comment: z.string().max(500).optional().nullable(),
  })
  .describe("Star rating + optional comment");

export const RefundBody = z
  .object({
    mode: z.enum(["FULL", "FOOD_ONLY"]).default("FULL"),
    reason: z.string().min(3).max(300),
    ticketId: Id.optional(),
  })
  .describe("Admin refund of one day-line");

export const CookApplyBody = z
  .object({
    mobile: z.string().min(10).max(20),
    kitchenName: z.string().min(3).max(100),
    pinCode: z.string().min(6).max(6),
    fssaiNumber: z.string().max(32).nullable().optional(),
    payoutUpiId: z.string().max(80).nullable().optional(),
    payoutAccountNote: z.string().max(500).nullable().optional(),
    pickupLandmark: z.string().max(300).nullable().optional(),
    acceptedKitchenStandards: z.literal(true),
  })
  .describe("Public cook enrollment");

const NoBody = z.object({}).describe("No body fields");

export const CancelBody = z
  .object({
    refundTo: z
      .enum(["SOURCE", "CREDIT"])
      .optional()
      .describe("Paid orders: refund to the original payment (default) or as instant LocalMeals credit"),
  })
  .describe("Cancel options");

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const MobileOut = z.string().max(20).describe("Mobile number");
const Label = Text(120);
const Percent = z.number().int().min(0).max(100);
const Numeric = z.string().max(20).describe("Decimal (numeric column, serialised as string)");
const LogisticsMode = z.enum(["SELF", "PARTNER"]);
const PlatformChannel = z.enum(["VOICE_IVR", "WHATSAPP_BOT", "WEB_STOREFRONT", "SYSTEM_CRON", "ADMIN"]);
const RoleOnOrder = z.enum(["CUSTOMER", "PAYER"]).nullable().describe("Caller's role on the order (owner view only)");

const FulfillmentOffers = z.object({
  cookDelivery: z.boolean(),
  pickup: z.boolean(),
  customerArrange: z.boolean(),
});

const ReviewSummary = z.object({
  average: z.number().min(0).max(5).nullable(),
  count: Count,
  public: z.boolean(),
});

const PublicCook = z
  .object({
    id: Uuid,
    kitchenName: Text(100),
    slugHandle: Slug,
    pinCode: Text(6),
    lat: Numeric.nullable(),
    lng: Numeric.nullable(),
    deliveryType: LogisticsMode,
    flatSelfDeliveryFee: z
      .union([Numeric, z.number().min(0).max(100_000)])
      .describe("Flat self-delivery fee in rupees"),
    fssaiNumber: Text(32).nullable(),
    fssaiVerifiedAt: IsoDateTime.nullable(),
    weekDiscountPercent: Percent,
    weekDiscountMinDays: z.number().int().min(0).max(14),
    pickupEnabled: z.boolean(),
    intakePaused: z.boolean(),
    intakePausedDate: Text(10).nullable(),
    lateOrdersEnabled: z.boolean(),
    fulfillmentOffers: FulfillmentOffers,
  })
  .describe("Customer-facing kitchen card (no cook mobile / payout details)");

const CookRef = z.object({ kitchenName: Text(100), slugHandle: Slug });
const CookRefWithId = CookRef.extend({ id: Uuid });

const MenuItem = z
  .object({
    id: Id,
    cookId: Uuid,
    itemName: Text(100),
    itemNameTa: Text(100).nullable(),
    pricePaise: Paise,
    itemType: z.enum(["HOT_MEAL", "DRY_PANTRY"]),
    isVeg: z.boolean(),
    allergens: z.array(Text(100)).max(50),
    dayOfWeek: z.number().int().min(0).max(6).nullable(),
    serviceDate: IsoDate.nullable(),
    mealType: MealType,
    totalStockAvailable: z.number().int().min(-1).max(1_000_000).describe("-1 = unlimited"),
    isAvailable: z.boolean(),
    imageUrl: Url.nullable(),
  })
  .describe("Menu plate");

const PaymentMethodOut = z.enum(["LINK", "UPI_QR", "CREDIT"]).describe("LINK | UPI_QR (pickup) | CREDIT (fully credit-paid)");
const QrImageUrl = Url.nullable().describe("Pickup UPI QR image while awaiting payment");

/** Full `orders` row as returned by create / cancel / refund flows. */
const OrderRow = z
  .object({
    id: Id,
    publicId: OrderPublicId,
    customerMobile: MobileOut,
    payerMobile: MobileOut.nullable(),
    cookId: Uuid,
    menuItemId: Id.nullable(),
    addressId: Id.nullable(),
    mealType: MealType,
    serviceDate: IsoDate,
    itemName: Text(100),
    itemNameTa: Text(100).nullable(),
    qty: Qty,
    spice: Spice,
    foodPaise: Paise,
    foodDiscountPaise: Paise,
    weekDiscountPercent: Percent.nullable(),
    deliveryPaise: Paise,
    platformFeePaise: Paise,
    convenienceFeePaise: Paise,
    creditAppliedPaise: Paise,
    paymentMethod: PaymentMethodOut,
    status: OrderStatus,
    settlementHold: z.boolean(),
    settlementId: Id.nullable(),
    fulfillmentMode: Text(16),
    logisticsMode: LogisticsMode,
    partnerShipmentId: Text(100).nullable(),
    partnerTrackingUrl: Url.nullable(),
    deliveryTargetAddress: Text(1000),
    channel: PlatformChannel,
    checkoutId: Text(20).nullable(),
    traceId: Text(40),
    gatewayTxnId: Text(100).nullable(),
    idempotencyKey: Text(160).nullable(),
    routeMapsUrl: Url.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .describe("Order day-line");

const Clawback = z
  .object({
    created: z.boolean(),
    amountPaise: Paise,
    entryId: Id.optional(),
  })
  .describe("Cook payout clawback queued for an already-settled plate");

const RefundedOrder = OrderRow.extend({
  clawback: Clawback.optional().describe("Absent when the line was already refunded"),
});

const CancelResult = RefundedOrder.extend({
  cancellable: z.boolean(),
  cancelRequestable: z.boolean(),
  mode: z.enum(["already_cancelled", "cancel_requested", "refunded", "cancelled"]),
});

const PickupReveal = z
  .object({
    fulfillmentMode: z.literal("PICKUP"),
    landmark: Text(500).nullable().describe("Shown only after payment"),
    pickupCode: OrderPublicId,
    revealAfterPay: z.boolean(),
  })
  .nullable();

/** Fields every audience sees (see http/orderViews.ts PUBLIC_ORDER_KEYS). */
const RedactedOrderBase = {
  id: Id,
  publicId: OrderPublicId,
  checkoutId: Text(20).nullable(),
  status: OrderStatus,
  itemName: Text(100),
  itemNameTa: Text(100).nullable(),
  qty: Qty,
  spice: Spice,
  foodPaise: Paise,
  foodDiscountPaise: Paise,
  weekDiscountPercent: Percent.nullable(),
  deliveryPaise: Paise,
  platformFeePaise: Paise,
  convenienceFeePaise: Paise,
  creditAppliedPaise: Paise,
  paymentMethod: PaymentMethodOut,
  gatewayTxnId: Text(100).nullable(),
  serviceDate: IsoDate,
  mealType: MealType,
  fulfillmentMode: Text(16),
  logisticsMode: LogisticsMode,
  partnerShipmentId: Text(100).nullable(),
  partnerTrackingUrl: Url.nullable(),
  channel: PlatformChannel,
  createdAt: IsoDateTime,
  cancellable: z.boolean(),
  cancelRequestable: z.boolean(),
  // Public (anonymous / non-owner) view:
  hasDeliveryAddress: z.boolean().optional().describe("Public view only"),
  // Owner / staff view:
  customerMobile: MobileOut.optional().describe("Owner/staff view only"),
  payerMobile: MobileOut.nullable().optional().describe("Owner/staff view only"),
  deliveryTargetAddress: Text(1000).optional().describe("Owner/staff view only"),
};

const CheckoutOrderLine = z
  .object({ ...RedactedOrderBase, lineTotalPaise: Paise })
  .describe("Checkout day-line (PII only for owner/staff)");

const OrderView = z
  .object({
    ...RedactedOrderBase,
    kitchenName: Text(100).nullable(),
    cookSlug: Slug.nullable(),
    canReorder: z.boolean(),
    deliveryWindow: Label.nullable(),
    kitchenDeliveryType: LogisticsMode,
    pickup: PickupReveal.describe("Null for non-pickup orders and in the public view"),
    roleOnOrder: RoleOnOrder,
    awaitingFamilyPay: z.boolean(),
    canReview: z.boolean(),
    hasReview: z.boolean(),
    review: z
      .object({
        id: Id,
        rating: z.number().int().min(1).max(5),
        comment: Text(500).nullable(),
        cookReply: Text(1000).nullable(),
      })
      .nullable(),
    paymentUrl: Url.optional().describe("Only while awaiting payment"),
    qrImageUrl: QrImageUrl,
  })
  .describe("Order view — redacted (no mobiles / address) unless the caller owns or runs the order");

const CheckoutView = z
  .object({
    checkoutId: CheckoutId,
    status: OrderStatus.describe("Aggregate status across day-lines"),
    gatewayTxnId: Text(100).nullable(),
    paymentUrl: Url.optional(),
    qrImageUrl: QrImageUrl,
    chargePaise: Paise.describe("Gateway amount (total − credit)"),
    creditAppliedPaise: Paise,
    totalPaise: Paise,
    kitchenName: Text(100).nullable(),
    cookSlug: Slug.nullable(),
    cancellable: z.boolean(),
    cancelRequestable: z.boolean(),
    roleOnOrder: RoleOnOrder,
    awaitingFamilyPay: z.boolean(),
    customerMobile: MobileOut.optional().describe("Owner/staff view only"),
    payerMobile: MobileOut.nullable().optional().describe("Owner/staff view only"),
    orders: z.array(CheckoutOrderLine).max(42),
  })
  .describe("Week-cart checkout");

const BatchResult = z
  .object({
    checkoutId: Text(20).describe("CHK-… (or the single line's LM-… on a legacy replay)"),
    publicId: Text(20).optional().describe("Replay only: same as checkoutId"),
    traceId: Text(40).optional(),
    gatewayTxnId: Text(100).nullable(),
    paymentUrl: Url.optional(),
    qrImageUrl: QrImageUrl.optional(),
    totalPaise: Paise,
    chargePaise: Paise.optional().describe("Gateway amount; 0 when credit paid everything"),
    creditAppliedPaise: Paise.optional(),
    foodDiscountTotalPaise: Paise,
    weekDiscountPercent: Percent.nullable(),
    status: z.enum(["AWAITING_PAYMENT", "PAID"]).describe("PAID when credit covered the whole cart"),
    orders: z.array(OrderRow).max(42),
  })
  .describe("Week-cart payment");

const Address = z
  .object({
    id: Id,
    label: z.enum(["HOME", "OFFICE", "OTHER"]),
    line1: Text(1000),
    line2: Text(1000).nullable(),
    pinCode: Text(6),
    lat: Numeric.nullable(),
    lng: Numeric.nullable(),
    isDefault: z.boolean(),
  })
  .describe("Saved address");

const ProfileCore = {
  mobile: MobileOut,
  fullName: Text(100),
  pinCode: Text(6).nullable(),
  preferredLanguage: Text(5),
  needsName: z.boolean(),
  leanWaStatus: z.boolean(),
};

const FamilyLinkStatus = z.enum(["PENDING", "ACTIVE", "REVOKED"]);
const FamilyLink = z
  .object({
    id: Id,
    seniorMobile: MobileOut,
    payerMobile: MobileOut,
    status: FamilyLinkStatus,
    createdAt: IsoDateTime,
    activatedAt: IsoDateTime.nullable(),
  })
  .describe("Child Pays family link");

const AdCampaign = z
  .object({
    id: Id,
    type: z.enum(["KITCHEN_BOOST", "EXTERNAL"]),
    status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ENDED"]),
    pinCode: Text(6),
    cookId: Uuid.nullable(),
    cookSlug: Slug.nullable(),
    kitchenName: Text(100).nullable(),
    title: Text(120),
    body: Text(2000).nullable(),
    ctaUrl: Text(500).nullable(),
    imageUrl: Text(500).nullable(),
    priority: z.number().int().min(-1_000_000).max(1_000_000),
    startsAt: IsoDateTime.nullable(),
    endsAt: IsoDateTime.nullable(),
    createdBy: Text(80).nullable(),
    createdAt: IsoDateTime,
  })
  .describe("Pin ad campaign");

const KitchenCard = PublicCook.extend({
  lunchCutoff: Label,
  deliveryWindow: Label,
  orderingOpen: z.boolean(),
  nextServiceDate: IsoDate.nullable(),
  openStatusLabel: Label,
  mealType: z.literal("LUNCH"),
  coverImageUrl: Url.nullable(),
  platesThisWeek: Count,
  reviews: ReviewSummary,
  sponsored: z.boolean(),
});

const MenuDay = z.object({
  serviceDate: IsoDate,
  dayOfWeek: z.number().int().min(0).max(6),
  dayLabel: Text(10),
  isToday: z.boolean(),
  orderingOpen: z.boolean(),
  itemCount: Count,
  menus: z.array(MenuItem).max(200),
  lateOrderingOpen: z.boolean(),
});

const MyOrder = z.object({
  id: Id,
  publicId: OrderPublicId,
  checkoutId: Text(20).nullable(),
  status: OrderStatus,
  itemName: Text(100),
  itemNameTa: Text(100).nullable(),
  qty: Qty,
  spice: Spice,
  menuItemId: Id.nullable(),
  foodPaise: Paise,
  foodDiscountPaise: Paise,
  weekDiscountPercent: Percent.nullable(),
  deliveryPaise: Paise,
  platformFeePaise: Paise,
  totalPaise: Paise,
  serviceDate: IsoDate,
  mealType: MealType,
  deliveryTargetAddress: Text(1000),
  fulfillmentMode: Text(16),
  logisticsMode: LogisticsMode,
  kitchenDeliveryType: LogisticsMode,
  partnerShipmentId: Text(100).nullable(),
  partnerTrackingUrl: Url.nullable(),
  pickup: PickupReveal,
  deliveryWindow: Label.nullable(),
  channel: PlatformChannel,
  gatewayTxnId: Text(100).nullable(),
  createdAt: IsoDateTime,
  kitchenName: Text(100).nullable(),
  cookSlug: Slug.nullable(),
  canReorder: z.boolean(),
  payerMobile: MobileOut.nullable(),
  childPays: z.boolean(),
  roleOnOrder: z.enum(["CUSTOMER", "PAYER"]),
  cancellable: z.boolean(),
  cancelRequestable: z.boolean(),
  canReview: z.boolean(),
  hasReview: z.boolean(),
  paymentUrl: Url.optional(),
});

const MyKitchen = z.object({
  id: Uuid,
  kitchenName: Text(100),
  slugHandle: Slug,
  pinCode: Text(6),
  followed: z.boolean(),
  recent: z.boolean(),
  orderingOpen: z.boolean(),
  nextServiceDate: IsoDate.nullable(),
  openStatusLabel: Label,
  lunchCutoff: Label,
  deliveryWindow: Label,
});

const TicketCategory = z.enum([
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

const KITCHEN_404 = { 404: "Kitchen not found" } as const;
const ORDER_CREATE_ERRORS = {
  404: "Kitchen, plate or address not found",
  409: "Idempotency conflict (retry with the same Idempotency-Key)",
  502: "Payment gateway unavailable — order released, retry shortly",
} as const;

export const customerOperations = defineOperations([
  {
    method: "get",
    path: "/kitchens",
    operationId: "listKitchens",
    summary: "Live kitchens (optionally by PIN), sponsored then open first",
    tags: ["Kitchens"],
    access: "public",
    query: KitchensQuery,
    response: z.array(KitchenCard).max(500),
  },
  {
    method: "get",
    path: "/ads",
    operationId: "listPinAds",
    summary: "Active pin ads / kitchen boosts (empty when ads are off)",
    tags: ["Kitchens"],
    access: "public",
    query: AdsQuery,
    response: z.object({
      adsEnabled: z.boolean(),
      boosts: z.array(AdCampaign).max(200),
      external: z.array(AdCampaign).max(200),
    }),
  },
  {
    method: "get",
    path: "/kitchens/:slug/menu",
    operationId: "getKitchenMenu",
    summary: "Kitchen menu for one service date and meal",
    tags: ["Kitchens"],
    access: "public",
    params: SlugParams,
    query: KitchenMenuQuery,
    response: z.object({
      cook: PublicCook,
      menus: z.array(MenuItem).max(200),
      serviceDate: IsoDate,
      mealType: MealType,
      mealLabel: Label,
      dayOfWeek: z.number().int().min(0).max(6),
      dayLabel: Text(10),
      lunchCutoff: Label,
      cutoff: Label,
      deliveryWindow: Label,
      orderingOpen: z.boolean(),
      mealEnabled: z.boolean(),
    }),
  },
  {
    method: "get",
    path: "/kitchens/:slug/meals",
    operationId: "getKitchenMealOptions",
    summary: "Meals with open days (advance ordering) in the next N days",
    tags: ["Kitchens"],
    access: "public",
    params: SlugParams,
    query: KitchenMealsQuery,
    response: z.object({
      cook: CookRef,
      days: z.number().int().min(0).max(999),
      meals: z
        .array(
          z.object({
            mealType: MealType,
            mealLabel: Label,
            openDayCount: Count,
            sampleItem: Text(100).nullable(),
          }),
        )
        .max(3),
    }),
  },
  {
    method: "get",
    path: "/kitchens/:slug/week",
    operationId: "getKitchenWeekPlan",
    summary: "Week plan: menus per day for one meal, cut-offs, pickup, week discount",
    tags: ["Kitchens"],
    access: "public",
    params: SlugParams,
    query: KitchenWeekQuery,
    response: z.object({
      cook: PublicCook,
      from: IsoDate,
      days: z.number().int().min(1).max(14),
      mealType: MealType,
      mealLabel: Label,
      mealEnabled: z.boolean(),
      lunchCutoff: Label,
      cutoff: Label,
      deliveryWindow: Label,
      orderingOpen: z.boolean(),
      intakePaused: z.boolean(),
      lateOrdersEnabled: z.boolean(),
      lateOrderingOpen: z.boolean(),
      nextServiceDate: IsoDate.nullable(),
      openStatusLabel: Label,
      fulfillmentOffers: FulfillmentOffers,
      pickup: z.object({
        available: z.boolean(),
        window: Label,
        hint: Text(300).nullable(),
      }),
      plan: z.array(MenuDay).max(14),
      weekDiscount: z.object({
        percent: Percent,
        minDays: z.number().int().min(0).max(14),
        label: Label.nullable(),
      }),
      reviews: ReviewSummary,
    }),
  },
  {
    method: "get",
    path: "/me/profile",
    operationId: "getMyProfile",
    summary: "Customer profile with saved addresses",
    tags: ["Account"],
    access: "customer",
    response: z.object({ ...ProfileCore, addresses: z.array(Address).max(10) }),
    errors: { 404: "Customer not found" },
  },
  {
    method: "patch",
    path: "/me/profile",
    operationId: "updateMyProfile",
    summary: "Update name, PIN, language or lean WhatsApp status",
    tags: ["Account"],
    access: "customer",
    body: ProfilePatchBody,
    response: z.object(ProfileCore),
    errors: { 404: "Customer not found" },
  },
  {
    method: "get",
    path: "/me/addresses",
    operationId: "listMyAddresses",
    summary: "Saved addresses (default first)",
    tags: ["Account"],
    access: "customer",
    response: z.object({ addresses: z.array(Address).max(10) }),
  },
  {
    method: "post",
    path: "/me/addresses",
    operationId: "createMyAddress",
    summary: "Save a HOME / OFFICE / OTHER address",
    tags: ["Account"],
    access: "customer",
    body: AddressCreateBody,
    response: Address,
  },
  {
    method: "patch",
    path: "/me/addresses/:id",
    operationId: "updateMyAddress",
    summary: "Edit a saved address or make it default",
    tags: ["Account"],
    access: "customer",
    params: IdParams,
    body: AddressPatchBody,
    response: Address,
  },
  {
    method: "post",
    path: "/orders",
    operationId: "createOrder",
    summary: "Place a single-day order (returns UPI payment link). Honors Idempotency-Key header",
    tags: ["Orders"],
    access: "customer",
    body: CreateOrderBody,
    response: OrderRow.extend({ paymentUrl: Url.optional(), qrImageUrl: QrImageUrl.optional() }),
    errors: ORDER_CREATE_ERRORS,
  },
  {
    method: "post",
    path: "/orders/batch",
    operationId: "createOrderBatch",
    summary: "Week cart checkout: several service days, one payment. Honors Idempotency-Key header",
    tags: ["Orders"],
    access: "customer",
    body: CreateOrderBatchBody,
    response: BatchResult,
    errors: ORDER_CREATE_ERRORS,
  },
  {
    method: "get",
    path: "/family/links",
    operationId: "listFamilyLinks",
    summary: "Child Pays links where I am the senior or the payer",
    tags: ["Family"],
    access: "customer",
    response: z.object({
      links: z
        .array(FamilyLink.extend({ role: z.enum(["SENIOR", "PAYER"]) }))
        .max(100),
    }),
  },
  {
    method: "post",
    path: "/family/links",
    operationId: "requestFamilyLink",
    summary: "Invite a family payer (PENDING until they accept)",
    tags: ["Family"],
    access: "customer",
    body: FamilyLinkBody,
    response: FamilyLink,
    successStatus: 201,
  },
  {
    method: "post",
    path: "/family/links/:id/accept",
    operationId: "acceptFamilyLink",
    summary: "Payer accepts a family link",
    tags: ["Family"],
    access: "customer",
    params: IdParams,
    body: NoBody,
    response: FamilyLink,
  },
  {
    method: "post",
    path: "/family/links/:id/revoke",
    operationId: "revokeFamilyLink",
    summary: "Senior or payer revokes a family link",
    tags: ["Family"],
    access: "customer",
    params: IdParams,
    body: NoBody,
    response: FamilyLink,
  },
  {
    method: "get",
    path: "/checkouts/:checkoutId",
    operationId: "getCheckout",
    summary: "Week-cart checkout (PII redacted unless owner / kitchen staff / admin)",
    tags: ["Orders"],
    access: "optionalSession",
    params: CheckoutIdParams,
    response: CheckoutView,
  },
  {
    method: "post",
    path: "/orders/late-request",
    operationId: "requestLateOrder",
    summary: "After cut-off: ask the kitchen to accept an order before paying",
    tags: ["Orders"],
    access: "customer",
    body: LateOrderBody,
    response: OrderRow.extend({ pendingApproval: z.boolean() }),
    errors: { 404: "Kitchen or plate not found" },
  },
  {
    method: "post",
    path: "/orders/:publicId/late-approve",
    operationId: "approveLateOrder",
    summary: "Kitchen accepts a late request (creates the payment link)",
    tags: ["Orders"],
    access: "cook",
    params: PublicIdParams,
    body: NoBody,
    response: OrderRow.extend({ paymentUrl: Url.optional(), qrImageUrl: QrImageUrl.optional() }),
    errors: { 502: "Payment gateway unavailable" },
  },
  {
    method: "post",
    path: "/orders/:publicId/late-decline",
    operationId: "declineLateOrder",
    summary: "Kitchen declines a late request",
    tags: ["Orders"],
    access: "cook",
    params: PublicIdParams,
    body: DeclineReasonBody,
    response: OrderRow,
  },
  {
    method: "post",
    path: "/orders/:publicId/cancel-accept",
    operationId: "acceptCancelRequest",
    summary: "Kitchen accepts a customer's after-cut-off cancel request (full refund)",
    tags: ["Orders"],
    access: "cook",
    params: PublicIdParams,
    body: NoBody,
    response: RefundedOrder,
  },
  {
    method: "post",
    path: "/orders/:publicId/cancel-decline",
    operationId: "declineCancelRequest",
    summary: "Kitchen declines a cancel request (order resumes)",
    tags: ["Orders"],
    access: "cook",
    params: PublicIdParams,
    body: DeclineReasonBody,
    response: OrderRow.extend({ mode: z.literal("cancel_declined") }),
  },
  {
    method: "get",
    path: "/me/orders",
    operationId: "listMyOrders",
    summary: "My order history (as customer or family payer), newest first",
    tags: ["Orders"],
    access: "customer",
    query: MyOrdersQuery,
    response: z.object({
      mobile: MobileOut,
      orders: z.array(MyOrder).max(100),
      limit: z.number().int().min(1).max(100),
      offset: z.number().int().min(0).max(1_000_000),
      hasMore: z.boolean(),
      nextOffset: z.number().int().min(0).max(1_000_100).nullable(),
    }),
  },
  {
    method: "get",
    path: "/me/kitchens",
    operationId: "listMyKitchens",
    summary: "Followed + recently ordered kitchens",
    tags: ["Kitchens"],
    access: "customer",
    response: z.object({ kitchens: z.array(MyKitchen).max(12) }),
  },
  {
    method: "post",
    path: "/me/kitchens/:slug/follow",
    operationId: "followKitchen",
    summary: "Follow a kitchen (WhatsApp alert when it posts a plate)",
    tags: ["Kitchens"],
    access: "customer",
    params: SlugParams,
    body: FollowBody,
    response: z.object({ alreadyFollowing: z.boolean(), cook: CookRef }),
  },
  {
    method: "post",
    path: "/me/kitchens/:slug/unfollow",
    operationId: "unfollowKitchen",
    summary: "Stop following a kitchen",
    tags: ["Kitchens"],
    access: "customer",
    params: SlugParams,
    body: NoBody,
    response: z.object({ cook: CookRef }),
  },
  {
    method: "get",
    path: "/orders/:publicId",
    operationId: "getOrder",
    summary: "Order view (pay / confirm pages) — PII redacted unless owner / kitchen staff / admin",
    tags: ["Orders"],
    access: "optionalSession",
    params: PublicIdParams,
    response: OrderView,
  },
  {
    method: "post",
    path: "/orders/:publicId/concern/photo",
    operationId: "uploadConcernPhoto",
    summary: "Upload an evidence photo for a concern (returns its URL)",
    tags: ["Orders"],
    access: "customer",
    params: PublicIdParams,
    bodyContentType: "multipart/form-data",
    body: z.object({ file: z.string().max(10_000_000).describe("binary image") }),
    response: z.object({ url: Text(200) }),
  },
  {
    method: "post",
    path: "/orders/:publicId/concern",
    operationId: "raiseOrderConcern",
    summary: "Raise a concern on a paid order (creates a support ticket)",
    tags: ["Orders"],
    access: "customer",
    params: PublicIdParams,
    body: ConcernBody,
    response: z.object({
      ok: z.literal(true),
      ticketId: Id,
      category: TicketCategory,
      status: z.enum(["OPEN", "RESOLVED", "CLOSED"]),
      photoUrl: Text(200).nullable(),
      message: Text(200),
    }),
  },
  {
    method: "post",
    path: "/orders/:publicId/review",
    operationId: "reviewOrder",
    summary: "Rate a delivered order",
    tags: ["Reviews"],
    access: "customer",
    params: PublicIdParams,
    body: ReviewBody,
    response: z.object({
      id: Id,
      orderPublicId: OrderPublicId,
      rating: z.number().int().min(1).max(5),
      comment: Text(500).nullable(),
      createdAt: IsoDateTime,
    }),
    successStatus: 201,
  },
  {
    method: "get",
    path: "/kitchens/:slug/reviews",
    operationId: "listKitchenReviews",
    summary: "Public kitchen reviews (list shown once the review threshold is met)",
    tags: ["Reviews"],
    access: "public",
    params: SlugParams,
    response: z.object({
      cook: CookRefWithId,
      summary: ReviewSummary,
      reviews: z
        .array(
          z.object({
            id: Id,
            rating: z.number().int().min(1).max(5),
            comment: Text(500).nullable(),
            cookReply: Text(1000).nullable(),
            cookRepliedAt: IsoDateTime.nullable(),
            createdAt: IsoDateTime,
            customerLabel: Text(20).describe("Masked mobile"),
          }),
        )
        .max(50),
    }),
    errors: KITCHEN_404,
  },
  {
    method: "post",
    path: "/orders/:publicId/cancel",
    operationId: "cancelOrder",
    summary: "Cancel an order (customer owner, its kitchen, or admin); after cut-off becomes a cancel request",
    tags: ["Orders"],
    access: "session",
    params: PublicIdParams,
    body: CancelBody,
    response: CancelResult,
  },
  {
    method: "post",
    path: "/orders/:publicId/refund",
    operationId: "refundOrder",
    summary: "Admin: refund a day-line (FULL or FOOD_ONLY)",
    tags: ["Orders"],
    access: "admin",
    params: PublicIdParams,
    body: RefundBody,
    response: RefundedOrder,
  },
  {
    method: "post",
    path: "/checkouts/:checkoutId/cancel",
    operationId: "cancelCheckout",
    summary: "Cancel every cancellable day-line in a week checkout",
    tags: ["Orders"],
    access: "session",
    params: CheckoutIdParams,
    body: CancelBody,
    response: z.object({
      checkoutId: CheckoutId,
      mode: z.enum(["refunded", "cancel_requested", "cancelled"]),
      cancelled: z.array(OrderPublicId).max(42),
      skipped: z.array(z.object({ publicId: OrderPublicId, reason: Text(500) })).max(42),
      orders: z.array(CancelResult).max(42),
    }),
  },
  {
    method: "post",
    path: "/cooks/apply",
    operationId: "applyAsCook",
    summary: "Public cook enrollment (403 while in single-kitchen launch mode)",
    tags: ["Cooks"],
    access: "public",
    body: CookApplyBody,
    response: z.object({
      ok: z.literal(true),
      id: Uuid,
      slugHandle: Slug,
      kitchenName: Text(100),
      onboardingStatus: z.enum(["DRAFT", "DOCS_SUBMITTED", "GATEWAY_KYC_PENDING", "LIVE", "REJECTED"]),
      message: Text(300),
    }),
  },
]);
