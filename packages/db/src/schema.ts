import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
  varchar,
  date,
  uniqueIndex,
  primaryKey,
  bigserial,
  index,
} from "drizzle-orm/pg-core";

export const userSegmentEnum = pgEnum("user_segment", ["SENIOR", "BACHELOR", "CHILD_PAYER"]);
export const logisticsModeEnum = pgEnum("logistics_mode", ["SELF", "PARTNER"]);
export const mealPeriodEnum = pgEnum("meal_period", ["BREAKFAST", "LUNCH", "DINNER"]);
export const inventoryCategoryEnum = pgEnum("inventory_category", ["HOT_MEAL", "DRY_PANTRY"]);
export const orderStateEnum = pgEnum("order_state", [
  "DRAFT",
  "PENDING_APPROVAL",
  "AWAITING_PAYMENT",
  "CONFIRMING_PAYMENT",
  "PAID",
  "CANCEL_REQUESTED",
  "COOKING",
  "PACKED",
  "ASSIGNING_RIDER",
  "DISPATCHED",
  "DELAYED",
  "DELIVERED",
  "RETURNED_TO_KITCHEN",
  "LOGISTICS_EXCEPTION",
  "CANCELLED",
  "REFUNDED",
  "FAILED",
]);
export const platformChannelEnum = pgEnum("platform_channel", [
  "VOICE_IVR",
  "WHATSAPP_BOT",
  "WEB_STOREFRONT",
  "SYSTEM_CRON",
  "ADMIN",
]);
export const adCampaignTypeEnum = pgEnum("ad_campaign_type", [
  "KITCHEN_BOOST",
  "EXTERNAL",
]);
export const adCampaignStatusEnum = pgEnum("ad_campaign_status", [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ENDED",
]);
export const onboardingStatusEnum = pgEnum("onboarding_status", [
  "DRAFT",
  "DOCS_SUBMITTED",
  "GATEWAY_KYC_PENDING",
  "LIVE",
  "REJECTED",
]);
export const spiceLevelEnum = pgEnum("spice_level", ["NORMAL", "LESS"]);
export const ticketStatusEnum = pgEnum("ticket_status", ["OPEN", "RESOLVED", "CLOSED"]);
export const ticketCategoryEnum = pgEnum("ticket_category", [
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
export const addressLabelEnum = pgEnum("address_label", ["HOME", "OFFICE", "OTHER"]);
export const paymentKindEnum = pgEnum("payment_kind", ["CHARGE", "REFUND"]);
export const familyLinkStatusEnum = pgEnum("family_link_status", [
  "PENDING",
  "ACTIVE",
  "REVOKED",
]);

export const users = pgTable("users", {
  mobileNumber: varchar("mobile_number", { length: 15 }).primaryKey(),
  fullName: varchar("full_name", { length: 100 }).notNull(),
  preferredLanguage: varchar("preferred_language", { length: 5 }).default("ta").notNull(),
  segment: userSegmentEnum("segment").default("BACHELOR").notNull(),
  /** Denormalized convenience copy of default HOME address line. */
  primaryAddress: text("primary_address").notNull(),
  officeAddress: text("office_address"),
  pinCode: varchar("pin_code", { length: 6 }),
  /** Opt-ins + audit (e.g. leanWaStatus, menuWaAlerts, menuWaAlertsAt). */
  consents: jsonb("consents").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const addresses = pgTable(
  "addresses",
  {
    id: serial("id").primaryKey(),
    userMobile: varchar("user_mobile", { length: 15 })
      .notNull()
      .references(() => users.mobileNumber, { onDelete: "cascade" }),
    label: addressLabelEnum("label").default("HOME").notNull(),
    line1: text("line1").notNull(),
    line2: text("line2"),
    pinCode: varchar("pin_code", { length: 6 }).notNull(),
    lat: numeric("lat", { precision: 10, scale: 7 }),
    lng: numeric("lng", { precision: 10, scale: 7 }),
    isDefault: boolean("is_default").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("addresses_user_idx").on(t.userMobile),
    uniqueIndex("addresses_user_label_uidx").on(t.userMobile, t.label),
  ],
);

export const cookProfiles = pgTable("cook_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  mobileNumber: varchar("mobile_number", { length: 15 }).notNull().unique(),
  kitchenName: varchar("kitchen_name", { length: 100 }).notNull(),
  slugHandle: varchar("slug_handle", { length: 50 }).notNull().unique(),
  lat: numeric("lat", { precision: 10, scale: 7 }),
  lng: numeric("lng", { precision: 10, scale: 7 }),
  pinCode: varchar("pin_code", { length: 6 }).notNull(),
  deliveryType: logisticsModeEnum("delivery_type").default("SELF").notNull(),
  flatSelfDeliveryFee: numeric("flat_self_delivery_fee", { precision: 5, scale: 2 })
    .default("25.00")
    .notNull(),
  maxSelfDistanceKm: numeric("max_self_distance_km", { precision: 3, scale: 1 })
    .default("3.0")
    .notNull(),
  maxDailyCapacity: integer("max_daily_capacity").default(40).notNull(),
  /** Cook-desired lunch order lock (local wall clock). */
  lunchCutoffHour: integer("lunch_cutoff_hour").default(8).notNull(),
  lunchCutoffMinute: integer("lunch_cutoff_minute").default(0).notNull(),
  /** Promised SELF lunch delivery window (local wall clock), e.g. 12:00–13:00. */
  deliveryWindowStartHour: integer("delivery_window_start_hour").default(12).notNull(),
  deliveryWindowStartMinute: integer("delivery_window_start_minute").default(0).notNull(),
  deliveryWindowEndHour: integer("delivery_window_end_hour").default(13).notNull(),
  deliveryWindowEndMinute: integer("delivery_window_end_minute").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  onboardingStatus: onboardingStatusEnum("onboarding_status").default("DRAFT").notNull(),
  fssaiNumber: varchar("fssai_number", { length: 32 }),
  fssaiVerifiedAt: timestamp("fssai_verified_at", { withTimezone: true }),
  payoutBeneficiaryRef: varchar("payout_beneficiary_ref", { length: 80 }),
  /** Manual UPI / VPA for ops payout until Route linked account is live. */
  payoutUpiId: varchar("payout_upi_id", { length: 80 }),
  /** Free-text bank / IFSC / payee name for manual settlement. */
  payoutAccountNote: text("payout_account_note"),
  /** Week cart: % off food when cart has ≥ weekDiscountMinDays (0 = off). Soft max 15. */
  weekDiscountPercent: integer("week_discount_percent").default(0).notNull(),
  weekDiscountMinDays: integer("week_discount_min_days").default(3).notNull(),
  /** Area landmark for pickup (not full home address). Shown only after pay. */
  pickupLandmark: text("pickup_landmark"),
  /** Cook opts into pickup when platform `pickup_enabled` flag is on. */
  pickupEnabled: boolean("pickup_enabled").default(false).notNull(),
  /**
   * When set to a service date (YYYY-MM-DD), kitchen rejects new intake for that day only.
   * Clears automatically the next calendar day (no cron).
   */
  intakePausedDate: varchar("intake_paused_date", { length: 10 }),
  /**
   * Cook opts into post–cut-off late asks (still gated by platform `late_orders_enabled`
   * and delivery−4h timing). Default on so existing kitchens keep prior behaviour.
   */
  lateOrdersEnabled: boolean("late_orders_enabled").default(true).notNull(),
  /** Cook / family delivers (SELF Maps). Default on. */
  offerCookDelivery: boolean("offer_cook_delivery").default(true).notNull(),
  /** Customer arranges their own auto / porter — ₹0 platform delivery. */
  offerCustomerArrange: boolean("offer_customer_arrange").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Per-meal cut-off + delivery ETA (breakfast / lunch / dinner). */
export const cookMealSettings = pgTable(
  "cook_meal_settings",
  {
    id: serial("id").primaryKey(),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id, { onDelete: "cascade" }),
    mealType: mealPeriodEnum("meal_type").notNull(),
    /** Lunch is always treated as enabled in product; B/D may be toggled off. */
    enabled: boolean("enabled").default(true).notNull(),
    cutoffHour: integer("cutoff_hour").notNull(),
    cutoffMinute: integer("cutoff_minute").default(0).notNull(),
    deliveryStartHour: integer("delivery_start_hour").notNull(),
    deliveryStartMinute: integer("delivery_start_minute").default(0).notNull(),
    deliveryEndHour: integer("delivery_end_hour").notNull(),
    deliveryEndMinute: integer("delivery_end_minute").default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("cook_meal_settings_cook_meal_uidx").on(t.cookId, t.mealType)],
);

export const dailyMenus = pgTable(
  "daily_menus",
  {
    id: serial("id").primaryKey(),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id, { onDelete: "cascade" }),
    itemName: varchar("item_name", { length: 100 }).notNull(),
    /** Tamil plate name — shown when customer locale is ta. */
    itemNameTa: varchar("item_name_ta", { length: 100 }),
    pricePaise: integer("price_paise").notNull(),
    itemType: inventoryCategoryEnum("item_type").default("HOT_MEAL").notNull(),
    isVeg: boolean("is_veg").default(true).notNull(),
    allergens: text("allergens").array().default([]).notNull(),
    /** 0=Sun … 6=Sat (JS Date.getDay). Used when serviceDate is null = weekly template. */
    dayOfWeek: integer("day_of_week"),
    serviceDate: date("service_date"),
    mealType: mealPeriodEnum("meal_type").default("LUNCH").notNull(),
    totalStockAvailable: integer("total_stock_available").default(-1).notNull(),
    isAvailable: boolean("is_available").default(true).notNull(),
    /** Public URL path e.g. /uploads/menu-….jpg */
    imageUrl: text("image_url"),
  },
  (t) => [
    index("daily_menus_cook_date_idx").on(t.cookId, t.serviceDate, t.mealType),
    index("daily_menus_cook_dow_idx").on(t.cookId, t.dayOfWeek),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: serial("id").primaryKey(),
    userMobile: varchar("user_mobile", { length: 15 })
      .notNull()
      .references(() => users.mobileNumber, { onDelete: "cascade" }),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id, { onDelete: "cascade" }),
    mealType: mealPeriodEnum("meal_type").default("LUNCH").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("subscriptions_user_cook_meal_uidx").on(t.userMobile, t.cookId, t.mealType)],
);

export const familyLinks = pgTable(
  "family_links",
  {
    id: serial("id").primaryKey(),
    seniorMobile: varchar("senior_mobile", { length: 15 })
      .notNull()
      .references(() => users.mobileNumber, { onDelete: "cascade" }),
    payerMobile: varchar("payer_mobile", { length: 15 })
      .notNull()
      .references(() => users.mobileNumber, { onDelete: "cascade" }),
    status: familyLinkStatusEnum("status").default("PENDING").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("family_links_senior_payer_uidx").on(t.seniorMobile, t.payerMobile)],
);

export const settlements = pgTable(
  "settlements",
  {
    id: serial("id").primaryKey(),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id),
    businessDate: date("business_date").notNull(),
    grossPaise: integer("gross_paise").notNull(),
    feesPaise: integer("fees_paise").default(0).notNull(),
    /** Food amount clawed back from prior refunds (already paid to cook). */
    clawbackPaise: integer("clawback_paise").default(0).notNull(),
    netPaise: integer("net_paise").notNull(),
    orderCount: integer("order_count").notNull(),
    gatewayBatchId: varchar("gateway_batch_id", { length: 100 }),
    status: varchar("status", { length: 32 }).default("COMPLETED").notNull(),
    /** Ops marked paid outside Route (UPI/NEFT). */
    manualPaidAt: timestamp("manual_paid_at", { withTimezone: true }),
    manualUtr: varchar("manual_utr", { length: 80 }),
    manualNote: text("manual_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("settlements_cook_date_uidx").on(t.cookId, t.businessDate)],
);

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    publicId: varchar("public_id", { length: 20 }).notNull().unique(),
    customerMobile: varchar("customer_mobile", { length: 15 })
      .notNull()
      .references(() => users.mobileNumber),
    /** Child-Pays: mobile that must complete UPI when status is PENDING_APPROVAL. */
    payerMobile: varchar("payer_mobile", { length: 15 }).references(() => users.mobileNumber),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id),
    menuItemId: integer("menu_item_id").references(() => dailyMenus.id),
    addressId: integer("address_id").references(() => addresses.id),
    mealType: mealPeriodEnum("meal_type").notNull(),
    serviceDate: date("service_date").notNull(),
    itemName: varchar("item_name", { length: 100 }).notNull(),
    /** Snapshot of Tamil name at order time (nullable). */
    itemNameTa: varchar("item_name_ta", { length: 100 }),
    qty: integer("qty").default(1).notNull(),
    spice: spiceLevelEnum("spice").default("NORMAL").notNull(),
    foodPaise: integer("food_paise").notNull(),
    /** Absolute food discount for this line (already includes qty). Week cart only. */
    foodDiscountPaise: integer("food_discount_paise").default(0).notNull(),
    /** Snapshot of cook week % when discount applied (null = none). */
    weekDiscountPercent: integer("week_discount_percent"),
    deliveryPaise: integer("delivery_paise").default(0).notNull(),
    platformFeePaise: integer("platform_fee_paise").default(700).notNull(),
    status: orderStateEnum("status").default("DRAFT").notNull(),
    settlementHold: boolean("settlement_hold").default(false).notNull(),
    settlementId: integer("settlement_id").references(() => settlements.id),
    /** DELIVERY (default) or PICKUP — landmark stored in deliveryTargetAddress for pickup. */
    fulfillmentMode: varchar("fulfillment_mode", { length: 16 }).default("DELIVERY").notNull(),
    /** Snapshot at dispatch: SELF (cook) or PARTNER (Shadowfax/etc.). */
    logisticsMode: logisticsModeEnum("logistics_mode").default("SELF").notNull(),
    /** Partner shipment id when logisticsMode=PARTNER. */
    partnerShipmentId: varchar("partner_shipment_id", { length: 100 }),
    /** Vendor tracking URL snapshot at create / last webhook. */
    partnerTrackingUrl: text("partner_tracking_url"),
    deliveryTargetAddress: text("delivery_target_address").notNull(),
    channel: platformChannelEnum("channel").default("WEB_STOREFRONT").notNull(),
    /** Shared id when several day-lines are paid in one checkout (CHK-xxxx). */
    checkoutId: varchar("checkout_id", { length: 20 }),
    /**
     * Durable journey id (trc_…) — same across create, Razorpay webhooks, outbox, worker.
     * Prefer this over requestId when debugging payments.
     */
    traceId: varchar("trace_id", { length: 40 }).notNull(),
    gatewayTxnId: varchar("gateway_txn_id", { length: 100 }),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).unique(),
    routeMapsUrl: text("route_maps_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("orders_idempotency_uidx").on(t.idempotencyKey),
    index("orders_cook_service_idx").on(t.cookId, t.serviceDate, t.status),
    index("orders_customer_idx").on(t.customerMobile),
    index("orders_checkout_idx").on(t.checkoutId),
    index("orders_gateway_txn_idx").on(t.gatewayTxnId),
    index("orders_trace_id_idx").on(t.traceId),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id),
    kind: paymentKindEnum("kind").default("CHARGE").notNull(),
    amountPaise: integer("amount_paise").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    gatewayTxnId: varchar("gateway_txn_id", { length: 100 }),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).unique(),
    rawPayload: jsonb("raw_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("payments_order_idx").on(t.orderId)],
);

export const cookLedger = pgTable(
  "cook_ledger",
  {
    id: serial("id").primaryKey(),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id),
    orderId: integer("order_id").references(() => orders.id),
    settlementId: integer("settlement_id").references(() => settlements.id),
    entryType: varchar("entry_type", { length: 40 }).notNull(),
    amountPaise: integer("amount_paise").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("cook_ledger_cook_idx").on(t.cookId)],
);

export const ratingsReviews = pgTable(
  "ratings_reviews",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id)
      .unique(),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id),
    customerMobile: varchar("customer_mobile", { length: 15 })
      .notNull()
      .references(() => users.mobileNumber),
    rating: integer("rating").notNull(),
    comment: text("comment"),
    /** Cook public reply — cannot delete/hide the customer review. */
    cookReply: text("cook_reply"),
    cookRepliedAt: timestamp("cook_replied_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("ratings_reviews_cook_idx").on(t.cookId)],
);

/** Customers who opt in to WhatsApp alerts when a kitchen posts menu. */
export const kitchenFollowers = pgTable(
  "kitchen_followers",
  {
    id: serial("id").primaryKey(),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id, { onDelete: "cascade" }),
    customerMobile: varchar("customer_mobile", { length: 15 })
      .notNull()
      .references(() => users.mobileNumber, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("kitchen_followers_cook_mobile_uidx").on(t.cookId, t.customerMobile),
    index("kitchen_followers_cook_idx").on(t.cookId),
  ],
);

export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").references(() => orders.id),
  cookId: uuid("cook_id").references(() => cookProfiles.id),
  customerMobile: varchar("customer_mobile", { length: 15 }),
  category: ticketCategoryEnum("category").default("OTHER").notNull(),
  status: ticketStatusEnum("status").default("OPEN").notNull(),
  source: varchar("source", { length: 40 }).default("WEB").notNull(),
  summary: text("summary").notNull(),
  /** Optional evidence photo from customer concern (/uploads/…). */
  photoUrl: text("photo_url"),
  decision: varchar("decision", { length: 40 }),
  slaDueAt: timestamp("sla_due_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const adminActionLog = pgTable("admin_action_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actor: varchar("actor", { length: 80 }).default("owner").notNull(),
  action: varchar("action", { length: 80 }).notNull(),
  entityType: varchar("entity_type", { length: 40 }).notNull(),
  entityId: varchar("entity_id", { length: 80 }).notNull(),
  reason: text("reason"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Platform kill switches — toggled from Admin → Features. */
export const platformFeatureFlags = pgTable("platform_feature_flags", {
  key: varchar("key", { length: 64 }).primaryKey(),
  enabled: boolean("enabled").default(true).notNull(),
  label: varchar("label", { length: 120 }).notNull(),
  description: text("description"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: varchar("updated_by", { length: 80 }),
});

export const platformEventLedger = pgTable("platform_event_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  associatedMobile: varchar("associated_mobile", { length: 15 }),
  orderId: integer("order_id"),
  cookId: uuid("cook_id"),
  channel: platformChannelEnum("channel").notNull(),
  eventName: varchar("event_name", { length: 100 }).notNull(),
  rawPayload: jsonb("raw_payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const outbox = pgTable(
  "outbox",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventName: varchar("event_name", { length: 100 }).notNull(),
    payload: jsonb("payload").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("outbox_unprocessed_idx").on(t.processedAt)],
);

export const cutoffLocks = pgTable(
  "cutoff_locks",
  {
    id: serial("id").primaryKey(),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id),
    mealType: mealPeriodEnum("meal_type").notNull(),
    serviceDate: date("service_date").notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }).defaultNow().notNull(),
    headcount: integer("headcount").default(0).notNull(),
    routeMapsUrl: text("route_maps_url"),
  },
  (t) => [uniqueIndex("cutoff_unique").on(t.cookId, t.mealType, t.serviceDate)],
);

/** Distributed rate-limit counters (shared across Cloud Run instances). */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    bucketKey: varchar("bucket_key", { length: 255 }).primaryKey(),
    hits: integer("hits").default(0).notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("rate_limit_buckets_reset_idx").on(t.resetAt)],
);

/** Logout / force-expire: tokens with iat <= revoked_before are rejected. */
export const authRevocations = pgTable(
  "auth_revocations",
  {
    mobileNumber: varchar("mobile_number", { length: 20 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(),
    revokedBefore: timestamp("revoked_before", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.mobileNumber, t.role] })],
);

/** Phone OTP challenges (hashed); one active row per mobile+role. */
export const authOtps = pgTable(
  "auth_otps",
  {
    id: serial("id").primaryKey(),
    mobileNumber: varchar("mobile_number", { length: 20 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("auth_otps_mobile_role_uidx").on(t.mobileNumber, t.role),
    index("auth_otps_expires_idx").on(t.expiresAt),
  ],
);

/**
 * Cook dish library — reusable plates for one-tap post to a date / weekly template.
 * Separate from daily_menus (which are live offerings).
 */
export const cookSavedPlates = pgTable(
  "cook_saved_plates",
  {
    id: serial("id").primaryKey(),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id, { onDelete: "cascade" }),
    itemName: varchar("item_name", { length: 100 }).notNull(),
    itemNameTa: varchar("item_name_ta", { length: 100 }),
    pricePaise: integer("price_paise").notNull(),
    isVeg: boolean("is_veg").default(true).notNull(),
    imageUrl: text("image_url"),
    mealType: mealPeriodEnum("meal_type").default("LUNCH").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("cook_saved_plates_cook_meal_name_uidx").on(t.cookId, t.mealType, t.itemName),
    index("cook_saved_plates_cook_idx").on(t.cookId),
  ],
);

export type CookMenuTemplateItem = {
  itemName: string;
  itemNameTa?: string | null;
  pricePaise: number;
  isVeg: boolean;
  imageUrl?: string | null;
};

/** Named multi-plate plans (e.g. “Weekday lunch”) posted in one tap. */
export const cookMenuTemplates = pgTable(
  "cook_menu_templates",
  {
    id: serial("id").primaryKey(),
    cookId: uuid("cook_id")
      .notNull()
      .references(() => cookProfiles.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    mealType: mealPeriodEnum("meal_type").default("LUNCH").notNull(),
    items: jsonb("items").$type<CookMenuTemplateItem[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("cook_menu_templates_cook_meal_name_uidx").on(t.cookId, t.mealType, t.name),
    index("cook_menu_templates_cook_idx").on(t.cookId),
  ],
);

/** Pin promotions — kitchen boost or external (gated by ads_enabled). */
export const adCampaigns = pgTable(
  "ad_campaigns",
  {
    id: serial("id").primaryKey(),
    type: adCampaignTypeEnum("type").notNull(),
    status: adCampaignStatusEnum("status").default("DRAFT").notNull(),
    pinCode: varchar("pin_code", { length: 6 }).notNull(),
    cookId: uuid("cook_id"),
    title: varchar("title", { length: 120 }).notNull(),
    body: text("body"),
    ctaUrl: varchar("cta_url", { length: 500 }),
    imageUrl: varchar("image_url", { length: 500 }),
    priority: integer("priority").default(0).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdBy: varchar("created_by", { length: 80 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("ad_campaigns_pin_status_idx").on(t.pinCode, t.status),
    index("ad_campaigns_cook_idx").on(t.cookId),
  ],
);

/** Short-lived WhatsApp guided checkout (pick kitchen / item / resume after address). */
export const waCheckoutSessions = pgTable("wa_checkout_sessions", {
  mobileNumber: varchar("mobile_number", { length: 15 }).primaryKey(),
  step: varchar("step", { length: 32 }).notNull(),
  payload: jsonb("payload")
    .$type<{
      kitchens?: Array<{ n: number; slug: string; name: string }>;
      cookSlug?: string;
      kitchenName?: string;
      items?: Array<{ n: number; menuItemId: number; name: string; pricePaise: number }>;
      itemIndex?: number;
      forceLate?: boolean;
    }>()
    .notNull()
    .default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
