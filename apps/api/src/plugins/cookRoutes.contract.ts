import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import {
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
  ScalarRecord,
  Slug,
  Spice,
  Text,
  Url,
  Uuid,
} from "../openapi/shared.js";
import { TicketCategory, TicketStatus } from "./adminShared.contract.js";

const TAGS = ["Cook desk"];

/* ───────────── Request building blocks ───────────── */

const Hour = z.number().int().min(0).max(23);
const Minute = z.number().int().min(0).max(59);
const DayOfWeek = z.number().int().min(0).max(6).describe("0=Sun … 6=Sat");
const PriceRupees = z.number().positive().max(1_000_000).describe("Price in rupees (converted to paise)");
const PricePaiseIn = z.number().int().positive().max(100_000_000).describe("Price in paise");
const ItemName = z.string().min(1).max(100);
const ItemNameTa = z.string().max(100).nullable().optional().describe("Tamil plate name");
const ImageUrlIn = Url.nullable().optional().describe("Uploaded photo URL (/uploads/…)");
/** Loose service date: YYYY-MM-DD, "" or null (weekly) — the service interprets it. */
const ServiceDateIn = z.string().max(10).nullable().optional().describe("YYYY-MM-DD; null with dayOfWeek = weekly");
const Allergens = z.array(z.string().max(100)).max(50);
const StockIn = z.number().int().min(-1).max(100_000).describe("Plates available (-1 = unlimited)");
const Landmark = z.string().max(300).nullable().optional().describe("Pickup area landmark (not a full address)");

/** Meal period query/path value — case-insensitive; invalid values fall back to LUNCH in queries. */
const MealQuery = z
  .string()
  .max(20)
  .optional()
  .describe("BREAKFAST | LUNCH | DINNER (case-insensitive, default LUNCH)");

export const SlugParams = z.object({ slug: Slug });
export const SlugIdParams = z.object({ slug: Slug, id: IdParam });
export const ReviewReplyParams = z.object({ slug: Slug, reviewId: IdParam });
export const MealSettingsParams = z.object({
  slug: Slug,
  mealType: z
    .string()
    .min(5)
    .max(9)
    .regex(/^(breakfast|lunch|dinner)$/i)
    .describe("BREAKFAST | LUNCH | DINNER (case-insensitive)"),
});
export const OrderParams = z.object({ publicId: OrderPublicId });

export const ManifestQuery = z.object({ date: IsoDate.optional(), meal: MealQuery });
export const UpcomingOrdersQuery = z.object({
  days: z.coerce.number().int().min(1).max(14).optional().describe("Days ahead (default 7)"),
});
export const MenuQuery = z.object({
  date: IsoDate.optional(),
  view: z.string().max(10).optional().describe("day | week (default day)"),
  meal: MealQuery,
});
export const MealQueryOnly = z.object({ meal: MealQuery });
export const DateQuery = z.object({ date: IsoDate.optional() });

export const ReviewReplyBody = z.object({ reply: z.string().min(1).max(500) });
export const CookTicketBody = z
  .object({
    summary: z.string().min(10).max(2000),
    category: TicketCategory.optional(),
    orderPublicId: OrderPublicId.optional().nullable(),
  })
  .describe("Cook desk issue report");
export const AdsBoostBody = z.object({
  title: z.string().min(2).max(120).optional(),
  days: z.number().int().min(1).max(30).optional(),
});
export const MealSettingsPatchBody = z.object({
  enabled: z.boolean().optional(),
  cutoffHour: Hour.optional(),
  cutoffMinute: Minute.optional(),
  deliveryWindow: z
    .object({
      startHour: Hour,
      startMinute: Minute.default(0),
      endHour: Hour,
      endMinute: Minute.default(0),
    })
    .optional(),
});
export const WeekDiscountBody = z.object({
  percent: z.number().int().min(0).max(15),
  minDays: z.number().int().min(2).max(14).default(3),
});
export const PickupBody = z
  .object({
    pickupEnabled: z.boolean().optional(),
    pickupLandmark: Landmark,
  })
  .refine((b) => b.pickupEnabled !== undefined || b.pickupLandmark !== undefined, {
    message: "pickupEnabled or pickupLandmark required",
  });
export const IntakePauseBody = z.object({ paused: z.boolean() });
export const LateOrdersBody = z.object({ enabled: z.boolean() });
export const CapacityTrimBody = z.object({ remaining: z.number().int().min(0).max(500) });
export const FulfillmentBody = z
  .object({
    cookDelivery: z.boolean().optional(),
    customerArrange: z.boolean().optional(),
    pickupEnabled: z.boolean().optional(),
    pickupLandmark: Landmark,
  })
  .refine(
    (b) =>
      b.cookDelivery !== undefined ||
      b.customerArrange !== undefined ||
      b.pickupEnabled !== undefined ||
      b.pickupLandmark !== undefined,
    { message: "At least one fulfillment field required" },
  );
export const MenuItemCreateBody = z
  .object({
    itemName: ItemName,
    itemNameTa: ItemNameTa,
    priceRupees: PriceRupees.optional(),
    pricePaise: PricePaiseIn.optional(),
    isVeg: z.boolean().optional(),
    allergens: Allergens.optional(),
    totalStockAvailable: StockIn.optional(),
    /** Calendar day; omit for today. Pass null with dayOfWeek for weekly. */
    serviceDate: ServiceDateIn,
    dayOfWeek: DayOfWeek.nullable().optional(),
    weekly: z.boolean().optional(),
    imageUrl: ImageUrlIn,
    mealType: MealType.optional(),
    saveToLibrary: z.boolean().optional(),
  })
  .refine((b) => b.pricePaise != null || b.priceRupees != null, {
    message: "priceRupees or pricePaise required",
  });
export const SavedPlateCreateBody = z.object({
  itemName: ItemName.optional(),
  itemNameTa: ItemNameTa,
  priceRupees: PriceRupees.optional(),
  pricePaise: PricePaiseIn.optional(),
  isVeg: z.boolean().optional(),
  imageUrl: ImageUrlIn,
  mealType: MealType.optional(),
  fromMenuId: Id.optional().describe("Copy fields from this live menu row"),
});
export const PostPlatesBody = z.object({
  serviceDate: ServiceDateIn,
  weekly: z.boolean().optional(),
  dayOfWeek: DayOfWeek.nullable().optional(),
});
export const MenuTemplateCreateBody = z.object({
  name: z.string().min(2).max(80),
  mealType: MealType.optional(),
  fromServiceDate: ServiceDateIn.describe("Snapshot this day's menu into the template"),
  items: z
    .array(
      z.object({
        itemName: ItemName,
        itemNameTa: ItemNameTa,
        pricePaise: PricePaiseIn,
        isVeg: z.boolean().optional(),
        imageUrl: ImageUrlIn,
      }),
    )
    .max(50)
    .optional()
    .describe("Plates (the service allows at most 12)"),
});
export const MenuItemPatchBody = z.object({
  itemName: ItemName.optional(),
  itemNameTa: ItemNameTa,
  priceRupees: PriceRupees.optional(),
  pricePaise: PricePaiseIn.optional(),
  isVeg: z.boolean().optional(),
  allergens: Allergens.optional(),
  totalStockAvailable: StockIn.optional(),
  isAvailable: z.boolean().optional(),
  imageUrl: ImageUrlIn,
  dayOfWeek: DayOfWeek.nullable().optional(),
  serviceDate: ServiceDateIn,
});
export const KitchenBatchBody = z.object({
  mealType: MealType.optional(),
  serviceDate: IsoDate.optional().describe("Default: today"),
});
const PhotoUploadBody = z.object({ file: z.string().max(10_000_000).describe("binary image") });
const NoBody = z.object({}).describe("No body fields");

/* ───────────── Response building blocks ───────────── */

const Ts = IsoDateTime;
const MobileOut = z.string().max(15);
const LogisticsMode = z.enum(["SELF", "PARTNER"]);
const Channel = z.enum(["VOICE_IVR", "WHATSAPP_BOT", "WEB_STOREFRONT", "SYSTEM_CRON", "ADMIN"]);
const SignedPaise = z.number().int().min(-100_000_000).max(100_000_000);
const Label = Text(200);

const KitchenRef = z.object({ id: Uuid, kitchenName: Text(100), slugHandle: Slug });

const OrderRow = z
  .object({
    id: Id,
    publicId: z.string().max(20),
    customerMobile: MobileOut,
    payerMobile: MobileOut.nullable(),
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
    weekDiscountPercent: z.number().int().min(0).max(100).nullable(),
    deliveryPaise: Paise,
    platformFeePaise: Paise,
    convenienceFeePaise: Paise,
    creditAppliedPaise: Paise,
    paymentMethod: z.enum(["LINK", "UPI_QR", "CREDIT"]),
    status: OrderStatus,
    settlementHold: z.boolean(),
    settlementId: Id.nullable(),
    fulfillmentMode: FulfillmentMode,
    logisticsMode: LogisticsMode,
    partnerShipmentId: Text(100).nullable(),
    partnerTrackingUrl: Url.nullable(),
    deliveryTargetAddress: Text(2000),
    channel: Channel,
    checkoutId: z.string().max(20).nullable(),
    traceId: z.string().max(40),
    gatewayTxnId: Text(100).nullable(),
    idempotencyKey: Text(160).nullable(),
    routeMapsUrl: Url.nullable(),
    createdAt: Ts,
    updatedAt: Ts,
  })
  .describe("Order row");

const MenuItemRow = z
  .object({
    id: Id,
    cookId: Uuid,
    itemName: Text(100),
    itemNameTa: Text(100).nullable(),
    pricePaise: Paise,
    itemType: z.enum(["HOT_MEAL", "DRY_PANTRY"]),
    isVeg: z.boolean(),
    allergens: Allergens,
    dayOfWeek: DayOfWeek.nullable(),
    serviceDate: IsoDate.nullable(),
    mealType: MealType,
    totalStockAvailable: z.number().int().min(-1).max(1_000_000),
    isAvailable: z.boolean(),
    imageUrl: Url.nullable(),
  })
  .describe("Menu item (dated plate or weekly template)");
const MenuItems = z.array(MenuItemRow).max(1000);

const SavedPlateRow = z
  .object({
    id: Id,
    cookId: Uuid,
    itemName: Text(100),
    itemNameTa: Text(100).nullable(),
    pricePaise: Paise,
    isVeg: z.boolean(),
    imageUrl: Url.nullable(),
    mealType: MealType,
    createdAt: Ts,
    updatedAt: Ts,
  })
  .describe("Saved plate");

const TemplateItem = z.object({
  itemName: Text(100),
  itemNameTa: Text(100).nullable().optional(),
  pricePaise: Paise,
  isVeg: z.boolean(),
  imageUrl: Url.nullable().optional(),
});
const TemplateItems = z.array(TemplateItem).max(50);
const MenuTemplateRow = z
  .object({
    id: Id,
    cookId: Uuid,
    name: Text(80),
    mealType: MealType,
    items: TemplateItems,
    createdAt: Ts,
    updatedAt: Ts,
  })
  .describe("Menu template");

const DeletedResponse = z.object({ ok: z.literal(true), id: Id });

const AdCampaign = z.object({
  id: Id,
  type: z.enum(["KITCHEN_BOOST", "EXTERNAL"]),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "ENDED"]),
  pinCode: z.string().max(6),
  cookId: Uuid.nullable(),
  cookSlug: Slug.nullable(),
  kitchenName: Text(100).nullable(),
  title: Text(120),
  body: Text(2000).nullable(),
  ctaUrl: Text(500).nullable(),
  imageUrl: Text(500).nullable(),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  startsAt: Ts.nullable(),
  endsAt: Ts.nullable(),
  createdBy: Text(80).nullable(),
  createdAt: Ts,
});

const Review = z.object({
  id: Id,
  rating: z.number().int().min(1).max(5),
  comment: Text(2000).nullable(),
  cookReply: Text(2000).nullable(),
  cookRepliedAt: Ts.nullable(),
  createdAt: Ts,
  customerLabel: Text(20).describe("Masked mobile (last 4 digits)"),
});

const DeliveryWindowParts = z.object({
  startHour: Hour,
  startMinute: Minute,
  endHour: Hour,
  endMinute: Minute,
});
const FulfillmentOffers = z.object({
  cookDelivery: z.boolean(),
  pickup: z.boolean(),
  customerArrange: z.boolean(),
});

const MealSettingsResponse = z.object({
  cook: KitchenRef,
  weekDiscount: z.object({
    percent: z.number().int().min(0).max(100),
    minDays: z.number().int().min(0).max(31),
    label: Label.nullable(),
    platformEnabled: z.boolean(),
  }),
  pickup: z.object({
    enabled: z.boolean(),
    landmark: Text(2000).nullable(),
    platformEnabled: z.boolean(),
  }),
  intake: z.object({
    paused: z.boolean(),
    pausedDate: z.string().max(10).nullable(),
    serviceDate: IsoDate,
  }),
  lateOrders: z.object({ enabled: z.boolean(), platformEnabled: z.boolean() }),
  fulfillmentOffers: FulfillmentOffers,
  delivery: z.object({
    type: LogisticsMode,
    platformPartnerEnabled: z.boolean(),
    partnerActive: z.boolean(),
  }),
  meals: z
    .array(
      z.object({
        mealType: MealType,
        mealLabel: Text(20),
        enabled: z.boolean(),
        cutoffHour: Hour,
        cutoffMinute: Minute,
        cutoff: Text(10).describe("HH:MM"),
        deliveryWindow: DeliveryWindowParts,
        deliveryWindowLabel: Text(20),
      }),
    )
    .max(3),
});

const CutoffLock = z.object({
  id: Id,
  cookId: Uuid,
  mealType: MealType,
  serviceDate: IsoDate,
  lockedAt: Ts,
  headcount: Count,
  routeMapsUrl: Url.nullable(),
});

const ManifestResponse = z.object({
  cook: KitchenRef.extend({ mobileNumber: MobileOut, deliveryType: LogisticsMode }),
  delivery: z.object({
    type: LogisticsMode,
    platformPartnerEnabled: z.boolean(),
    partnerActive: z.boolean(),
  }),
  mealType: MealType,
  mealLabel: Text(20),
  mealEnabled: z.boolean(),
  lock: CutoffLock.optional().describe("Present once the meal's cut-off has locked"),
  orders: z.array(OrderRow).max(2000),
  lunchCutoff: Text(10),
  cutoff: Text(10),
  deliveryWindow: Text(20),
  deliveryWindowParts: DeliveryWindowParts,
  earnings: z.object({
    serviceDate: IsoDate,
    note: Label,
    meal: z.object({ mealType: MealType, plates: Count, foodPaise: Paise }),
    day: z.object({
      plates: Count,
      foodPaise: Paise,
      deliveredPlates: Count,
      deliveredFoodPaise: Paise,
      heldPlates: Count,
      pendingClawbackPaise: Paise,
      clawbackPaise: Paise,
    }),
    payout: z.object({
      status: z.enum(["NONE", "PAID", "PENDING", "OTHER"]),
      label: Label,
      detail: Label.nullable(),
      netPaise: SignedPaise.nullable(),
      orderCount: Count.nullable(),
      manualPaidAt: Ts.nullable(),
      manualUtr: Text(80).nullable(),
      settlementStatus: Text(32).nullable(),
      clawbackPaise: Paise,
    }),
  }),
  whatsapp: z.object({ cookMobile: MobileOut, note: Label }),
});

const UpcomingResponse = z.object({
  from: IsoDate,
  to: IsoDate,
  days: z
    .array(
      z.object({
        serviceDate: IsoDate,
        dayLabel: Text(10),
        mealType: MealType,
        totalPlates: Count,
        lines: z
          .array(
            z.object({
              itemName: Text(100),
              itemNameTa: Text(100).nullable(),
              qty: Count,
              orderCount: Count,
            }),
          )
          .max(500),
      }),
    )
    .max(42),
});

/** Outbox payloads are small JSON objects; bounded to two levels for the contract. */
const Scalar = z.union([z.string().max(2000), z.number().min(-1e15).max(1e15), z.boolean(), z.null()]);
const FeedPayload = z
  .record(z.string().max(100), z.union([Scalar, z.array(z.union([Scalar, ScalarRecord])).max(200), ScalarRecord]))
  .describe("Outbox event payload");

const WhatsAppFeedResponse = z.object({
  cookMobile: MobileOut,
  messages: z
    .array(
      z.object({
        id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        eventName: Text(100),
        preview: Text(1000),
        to: MobileOut,
        processedAt: Ts.nullable(),
        createdAt: Ts,
        payload: FeedPayload,
      }),
    )
    .max(20),
});

const KitchenStateLine = z.object({ publicIds: z.array(OrderPublicId).max(2000) });

/* ───────────── Operations ───────────── */

export const cookOperations = defineOperations([
  {
    method: "get",
    path: "/cooks/:slug/reviews",
    operationId: "listCookDeskReviews",
    summary: "Reviews for the kitchen (cook desk view, masked customers)",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    response: z.object({
      cook: KitchenRef,
      summary: z.object({
        count: Count,
        average: z.number().min(0).max(5).nullable(),
        public: z.boolean(),
      }),
      reviews: z
        .array(
          Review.extend({
            orderPublicId: z.string().max(20),
            itemName: Text(100),
            serviceDate: IsoDate,
          }),
        )
        .max(100),
      softLaunchMin: Count.describe("Reviews needed before the rating goes public"),
    }),
  },
  {
    method: "post",
    path: "/cooks/:slug/reviews/:reviewId/reply",
    operationId: "replyToCookReview",
    summary: "Post the cook's public reply to a review",
    tags: TAGS,
    access: "cook",
    params: ReviewReplyParams,
    body: ReviewReplyBody,
    response: Review,
  },
  {
    method: "get",
    path: "/cooks/:slug/manifest",
    operationId: "getCookManifest",
    summary: "Meal manifest: paid orders, cut-off lock, earnings and payout",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    query: ManifestQuery,
    response: ManifestResponse,
  },
  {
    method: "get",
    path: "/cooks/:slug/upcoming-orders",
    operationId: "listCookUpcomingOrders",
    summary: "Paid plates for upcoming service days (prep / shopping forecast)",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    query: UpcomingOrdersQuery,
    response: UpcomingResponse,
  },
  {
    method: "get",
    path: "/cooks/:slug/ads",
    operationId: "listCookBoosts",
    summary: "Kitchen boost campaigns for this cook",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    response: z.object({ adsEnabled: z.boolean(), campaigns: z.array(AdCampaign).max(20) }),
  },
  {
    method: "post",
    path: "/cooks/:slug/ads/boost",
    operationId: "requestCookBoost",
    summary: "Request a pin-code kitchen boost (draft for admin approval)",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: AdsBoostBody,
    response: z.object({ campaign: AdCampaign, note: Label }),
  },
  {
    method: "get",
    path: "/cooks/:slug/whatsapp-feed",
    operationId: "getCookWhatsAppFeed",
    summary: "Recent cook-facing WhatsApp events",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    response: WhatsAppFeedResponse,
  },
  {
    method: "get",
    path: "/cooks/:slug/meal-settings",
    operationId: "getCookMealSettings",
    summary: "Per-meal cut-offs, delivery windows and kitchen toggles",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    response: MealSettingsResponse,
  },
  {
    method: "patch",
    path: "/cooks/:slug/meal-settings/:mealType",
    operationId: "updateCookMealSettings",
    summary: "Update one meal's enabled flag, cut-off or delivery window",
    tags: TAGS,
    access: "cook",
    params: MealSettingsParams,
    body: MealSettingsPatchBody,
    response: MealSettingsResponse,
  },
  {
    method: "patch",
    path: "/cooks/:slug/week-discount",
    operationId: "setCookWeekDiscount",
    summary: "Set the week-cart food discount",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: WeekDiscountBody,
    response: z.object({
      weekDiscountPercent: z.number().int().min(0).max(100),
      weekDiscountMinDays: z.number().int().min(0).max(31),
      label: Label.nullable(),
    }),
  },
  {
    method: "patch",
    path: "/cooks/:slug/pickup",
    operationId: "setCookPickup",
    summary: "Enable kitchen pickup and set the pickup landmark",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: PickupBody,
    response: z.object({
      pickupEnabled: z.boolean(),
      pickupLandmark: Text(2000).nullable(),
      platformEnabled: z.boolean(),
      availableToCustomers: z.boolean(),
      fulfillmentOffers: FulfillmentOffers,
    }),
  },
  {
    method: "patch",
    path: "/cooks/:slug/intake-pause",
    operationId: "setCookIntakePause",
    summary: "Pause or resume new orders for today",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: IntakePauseBody,
    response: z.object({
      paused: z.boolean(),
      pausedDate: IsoDate.nullable(),
      serviceDate: IsoDate,
    }),
  },
  {
    method: "patch",
    path: "/cooks/:slug/late-orders",
    operationId: "setCookLateOrders",
    summary: "Opt in/out of post–cut-off late order requests",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: LateOrdersBody,
    response: z.object({ enabled: z.boolean(), platformEnabled: z.boolean() }),
  },
  {
    method: "get",
    path: "/cooks/:slug/capacity-today",
    operationId: "getCookCapacityToday",
    summary: "Plates used vs capacity for today",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    response: z.object({
      serviceDate: IsoDate,
      used: Count,
      maxDailyCapacity: Count,
      remaining: Count,
      paused: z.boolean(),
    }),
  },
  {
    method: "patch",
    path: "/cooks/:slug/capacity-today",
    operationId: "trimCookCapacityToday",
    summary: "Set how many plates can still be sold today (0 pauses intake)",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: CapacityTrimBody,
    response: z.object({
      serviceDate: IsoDate,
      used: Count,
      remaining: Count,
      maxDailyCapacity: Count,
      paused: z.boolean(),
    }),
  },
  {
    method: "patch",
    path: "/cooks/:slug/fulfillment",
    operationId: "setCookFulfillment",
    summary: "Toggle cook delivery, pickup and customer-arranged delivery",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: FulfillmentBody,
    response: z.object({
      fulfillmentOffers: FulfillmentOffers,
      pickupEnabled: z.boolean(),
      pickupLandmark: Text(2000).nullable(),
      pickupPlatformEnabled: z.boolean(),
    }),
  },
  {
    method: "get",
    path: "/cooks/:slug/menu",
    operationId: "listCookMenu",
    summary: "Kitchen menu for a day (dated + weekly) or the weekly template view",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    query: MenuQuery,
    response: z.union([
      z
        .object({
          cook: KitchenRef,
          serviceDate: IsoDate,
          mealType: MealType,
          mealLabel: Text(20),
          dayOfWeek: DayOfWeek,
          view: z.literal("day"),
          menus: MenuItems,
          weeklyForDay: MenuItems,
        })
        .describe("view=day"),
      z
        .object({
          cook: KitchenRef,
          serviceDate: IsoDate,
          mealType: MealType,
          mealLabel: Text(20),
          view: z.literal("week"),
          menus: MenuItems,
          byDay: z
            .object({
              "0": MenuItems,
              "1": MenuItems,
              "2": MenuItems,
              "3": MenuItems,
              "4": MenuItems,
              "5": MenuItems,
              "6": MenuItems,
            })
            .describe("Weekly plates keyed by day of week (0=Sun)"),
        })
        .describe("view=week"),
    ]),
  },
  {
    method: "post",
    path: "/cooks/:slug/menu",
    operationId: "addCookMenuItem",
    summary: "Publish a plate for a date or as a weekly template",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: MenuItemCreateBody,
    successStatus: 201,
    response: MenuItemRow,
  },
  {
    method: "get",
    path: "/cooks/:slug/saved-plates",
    operationId: "listCookSavedPlates",
    summary: "Saved plate library for a meal",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    query: MealQueryOnly,
    response: z.object({
      cookSlug: Slug,
      mealType: MealType,
      plates: z
        .array(SavedPlateRow.omit({ cookId: true, createdAt: true }))
        .max(1000),
    }),
  },
  {
    method: "post",
    path: "/cooks/:slug/saved-plates",
    operationId: "saveCookSavedPlate",
    summary: "Save (upsert) a plate to the library, optionally from a menu item",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: SavedPlateCreateBody,
    successStatus: 201,
    response: SavedPlateRow,
  },
  {
    method: "delete",
    path: "/cooks/:slug/saved-plates/:id",
    operationId: "deleteCookSavedPlate",
    summary: "Delete a saved plate",
    tags: TAGS,
    access: "cook",
    params: SlugIdParams,
    response: DeletedResponse,
  },
  {
    method: "post",
    path: "/cooks/:slug/saved-plates/:id/post",
    operationId: "postCookSavedPlate",
    summary: "Post a saved plate to a date or weekly day",
    tags: TAGS,
    access: "cook",
    params: SlugIdParams,
    body: PostPlatesBody,
    successStatus: 201,
    response: MenuItemRow,
  },
  {
    method: "get",
    path: "/cooks/:slug/menu-templates",
    operationId: "listCookMenuTemplates",
    summary: "Named multi-plate menu templates for a meal",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    query: MealQueryOnly,
    response: z.object({
      templates: z
        .array(
          z.object({
            id: Id,
            name: Text(80),
            mealType: MealType,
            items: TemplateItems,
            itemCount: Count,
            updatedAt: Ts,
          }),
        )
        .max(500),
    }),
  },
  {
    method: "post",
    path: "/cooks/:slug/menu-templates",
    operationId: "saveCookMenuTemplate",
    summary: "Save (upsert by name) a menu template from plates or a day's menu",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: MenuTemplateCreateBody,
    successStatus: 201,
    response: MenuTemplateRow,
  },
  {
    method: "delete",
    path: "/cooks/:slug/menu-templates/:id",
    operationId: "deleteCookMenuTemplate",
    summary: "Delete a menu template",
    tags: TAGS,
    access: "cook",
    params: SlugIdParams,
    response: DeletedResponse,
  },
  {
    method: "post",
    path: "/cooks/:slug/menu-templates/:id/post",
    operationId: "postCookMenuTemplate",
    summary: "Post every plate in a template to a date or weekly day",
    tags: TAGS,
    access: "cook",
    params: SlugIdParams,
    body: PostPlatesBody,
    successStatus: 201,
    response: z.object({ ok: z.literal(true), count: Count, items: z.array(MenuItemRow).max(50) }),
  },
  {
    method: "post",
    path: "/cooks/:slug/menu/photo",
    operationId: "uploadCookMenuPhoto",
    summary: "Upload a plate photo; returns its public URL",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: PhotoUploadBody,
    bodyContentType: "multipart/form-data",
    response: z.object({ url: Url }),
  },
  {
    method: "patch",
    path: "/cooks/:slug/menu/:id",
    operationId: "updateCookMenuItem",
    summary: "Edit a menu item (price, availability, photo, schedule…)",
    tags: TAGS,
    access: "cook",
    params: SlugIdParams,
    body: MenuItemPatchBody,
    response: MenuItemRow,
  },
  {
    method: "delete",
    path: "/cooks/:slug/menu/:id",
    operationId: "deleteCookMenuItem",
    summary: "Permanently remove a menu item",
    tags: TAGS,
    access: "cook",
    params: SlugIdParams,
    response: DeletedResponse,
  },
  {
    method: "get",
    path: "/cooks/:slug/late-pending",
    operationId: "listCookLatePending",
    summary: "Late order requests awaiting the cook's decision",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    query: DateQuery,
    response: z.object({ cook: KitchenRef, serviceDate: IsoDate, orders: z.array(OrderRow).max(2000) }),
  },
  {
    method: "get",
    path: "/cooks/:slug/cancel-pending",
    operationId: "listCookCancelPending",
    summary: "Customer cancel requests awaiting the cook's decision",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    query: DateQuery,
    response: z.object({
      cookSlug: Slug,
      serviceDate: IsoDate,
      orders: z
        .array(
          z.object({
            publicId: z.string().max(20),
            itemName: Text(100),
            qty: Count,
            customerMobile: MobileOut,
            status: OrderStatus,
            mealType: MealType,
            serviceDate: IsoDate,
            deliveryTargetAddress: Text(2000),
          }),
        )
        .max(2000),
    }),
  },
  {
    method: "post",
    path: "/cooks/:slug/cooking",
    operationId: "startCookingBatch",
    summary: "Move every PAID order for the meal to COOKING",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: KitchenBatchBody,
    response: KitchenStateLine.extend({ cooking: Count }),
  },
  {
    method: "post",
    path: "/cooks/:slug/pack",
    operationId: "packBatch",
    summary: "Move every COOKING order for the meal to PACKED",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: KitchenBatchBody,
    response: KitchenStateLine.extend({ packed: Count }),
  },
  {
    method: "post",
    path: "/cooks/:slug/dispatch",
    operationId: "dispatchBatch",
    summary: "Dispatch every PACKED delivery order for the meal (self or partner)",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: KitchenBatchBody,
    response: KitchenStateLine.extend({
      dispatched: Count,
      partnerAssigned: Count,
      skippedPickup: Count,
    }),
  },
  {
    method: "post",
    path: "/cooks/:slug/tickets",
    operationId: "createCookTicket",
    summary: "Cook desk: report an issue (creates a support ticket, source COOK)",
    tags: TAGS,
    access: "cook",
    params: SlugParams,
    body: CookTicketBody,
    response: z.object({
      ok: z.literal(true),
      ticketId: Id,
      status: TicketStatus,
      source: Text(40),
    }),
  },
  {
    method: "post",
    path: "/orders/:publicId/cooking",
    operationId: "markOrderCooking",
    summary: "Move one order to COOKING",
    tags: TAGS,
    access: "cook",
    params: OrderParams,
    body: NoBody,
    response: OrderRow,
  },
  {
    method: "post",
    path: "/orders/:publicId/pack",
    operationId: "markOrderPacked",
    summary: "Move one order to PACKED",
    tags: TAGS,
    access: "cook",
    params: OrderParams,
    body: NoBody,
    response: OrderRow,
  },
  {
    method: "post",
    path: "/orders/:publicId/dispatch",
    operationId: "markOrderDispatched",
    summary: "Dispatch one order (self delivery or partner rider request)",
    tags: TAGS,
    access: "cook",
    params: OrderParams,
    body: NoBody,
    response: OrderRow,
  },
  {
    method: "post",
    path: "/orders/:publicId/rider-assigned",
    operationId: "markOrderRiderAssigned",
    summary: "Partner rider found: ASSIGNING_RIDER → DISPATCHED",
    tags: TAGS,
    access: "cook",
    params: OrderParams,
    body: NoBody,
    response: OrderRow,
  },
  {
    method: "post",
    path: "/orders/:publicId/delivered",
    operationId: "markOrderDelivered",
    summary: "Mark one order delivered / picked up",
    tags: TAGS,
    access: "cook",
    params: OrderParams,
    body: NoBody,
    response: OrderRow,
  },
]);
