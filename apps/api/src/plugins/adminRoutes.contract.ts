import { z } from "zod";
import { MAX_COOK_COMMISSION_BPS, MAX_PLATFORM_FEE_PAISE } from "@localmeals/domain";
import { defineOperations } from "../openapi/registry.js";
import { Count, Id, IdParam, IsoDate, MealType, OrderStatus, Paise, PinCode, Spice, Text, Uuid } from "../openapi/shared.js";
import {
  AdCampaign,
  AdStatus,
  Bps,
  AdType,
  BigId,
  ChannelEnum,
  CookProfileRow,
  JsonObject,
  OnboardingStatus,
  OrderRow,
  PaiseTotal,
  SettlementRow,
  StoredMobile,
  SupportTicketRow,
  TicketCategory,
  TicketStatus,
  Timestamp,
} from "./adminShared.contract.js";

// ---- Requests ----

export const AdminOrdersQuery = z.object({
  mobile: z.string().max(20).optional().describe("Customer or payer mobile"),
  cookSlug: z.string().max(50).optional().describe("Kitchen slug"),
  serviceDate: z.string().max(20).optional().describe("YYYY-MM-DD"),
  status: z.string().max(40).optional().describe("Order status"),
  limit: z.coerce.number().int().min(1).max(100).optional().describe("Max rows (default 40)"),
});
export const AdminAttentionQuery = z.object({
  limit: z.coerce.number().int().min(1).max(80).optional().describe("Max rows (default 40)"),
});
export const AdminOrderKeyParams = z.object({
  publicId: z
    .string()
    .min(1)
    .max(160)
    .describe("Order publicId (LM-…), checkoutId (CHK-…), traceId (trc_…) or gateway txn id"),
});
export const AdminIdParams = z.object({ id: IdParam });
export const AdminCookIdParams = z.object({ id: Uuid.describe("Cook id") });
export const AdminTicketPatchBody = z
  .object({ category: TicketCategory.optional(), status: TicketStatus.optional() })
  .describe("Fields to change (at least one)");
export const AdminPayoutDetailsBody = z
  .object({
    payoutUpiId: z.string().max(80).nullable().optional().describe("UPI VPA"),
    payoutAccountNote: z.string().max(2000).nullable().optional().describe("Bank / IFSC / payee note"),
    payoutBeneficiaryRef: z.string().max(80).nullable().optional().describe("Razorpay Route account (acc_…)"),
    pickupLandmark: z.string().max(2000).nullable().optional().describe("Pickup area landmark"),
    pickupEnabled: z.boolean().optional(),
    deliveryType: z.enum(["SELF", "PARTNER"]).optional(),
  })
  .describe("Cook payout / pickup details");
export const AdminSettlementsQuery = z.object({
  filter: z.string().max(10).optional().describe("open (default) | all"),
});
export const AdminManualPayBody = z
  .object({
    utr: z.string().min(4).max(80).describe("UTR / UPI reference"),
    note: z.string().max(2000).optional(),
  })
  .describe("Mark a settlement paid outside Route");
export const AdminTurnoverQuery = z.object({
  period: z.enum(["week", "month", "year", "custom"]).default("month"),
  from: IsoDate.optional().describe("custom period start"),
  to: IsoDate.optional().describe("custom period end"),
  cookId: Uuid.optional(),
});
export const AdminFeatureKeyParams = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/).describe("Feature flag key"),
});
export const AdminFeatureBody = z.object({ enabled: z.boolean() }).describe("Toggle a feature flag");
export const AdminPricingBody = z
  .object({
    platformFeePaise: z.number().int().min(0).max(MAX_PLATFORM_FEE_PAISE).optional().describe("Customer fee per checkout"),
    cookCommissionBps: z
      .number()
      .int()
      .min(0)
      .max(MAX_COOK_COMMISSION_BPS)
      .optional()
      .describe("Default cook commission on food (basis points)"),
  })
  .describe("Platform pricing (at least one field)");
export const AdminCookCommissionBody = z
  .object({
    commissionBps: z
      .number()
      .int()
      .min(0)
      .max(MAX_COOK_COMMISSION_BPS)
      .nullable()
      .describe("Override in basis points; null = use platform default"),
  })
  .describe("Per-cook commission override");
export const AdminAdsQuery = z.object({
  pin: PinCode.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const AdminAdUpsertBody = z
  .object({
    id: Id.optional().describe("Existing campaign id (update)"),
    type: AdType,
    status: AdStatus,
    pinCode: PinCode,
    cookId: Uuid.nullable().optional(),
    title: z.string().min(2).max(120),
    body: z.string().max(500).nullable().optional(),
    ctaUrl: z.string().max(500).nullable().optional(),
    imageUrl: z.string().max(500).nullable().optional(),
    priority: z.number().int().min(0).max(100).optional(),
    startsAt: z.string().max(40).datetime().nullable().optional(),
    endsAt: z.string().max(40).datetime().nullable().optional(),
  })
  .describe("Create or update an ad campaign");
export const AdminAdStatusBody = z.object({ status: AdStatus }).describe("New campaign status");

// ---- Responses ----

const OrderListRow = z.object({
  id: Id,
  publicId: Text(20),
  checkoutId: Text(20).nullable(),
  status: OrderStatus,
  customerMobile: StoredMobile,
  payerMobile: StoredMobile.nullable(),
  serviceDate: IsoDate,
  mealType: MealType,
  itemName: Text(100),
  qty: Count,
  totalPaise: Paise,
  settlementHold: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  kitchenName: Text(100).nullable(),
  cookSlug: Text(50).nullable(),
});

const TicketCook = z.object({
  id: Uuid,
  kitchenName: Text(100),
  slugHandle: Text(50),
  mobileNumber: StoredMobile,
  isActive: z.boolean(),
  onboardingStatus: OnboardingStatus,
});

const OutboxSummary = z.object({
  id: BigId,
  eventName: Text(100),
  attempts: Count,
  lastError: Text(4000).nullable(),
  processedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  status: z.enum(["pending", "failed", "ok"]),
  publicId: Text(40).nullable(),
  checkoutId: Text(20).nullable(),
  traceId: Text(40).nullable(),
});

const SupportBundle = z
  .object({
    matchedBy: z.enum(["publicId", "checkoutId", "traceId", "gatewayTxnId"]),
    order: z.object({
      id: Id,
      publicId: Text(20),
      checkoutId: Text(20).nullable(),
      traceId: Text(40),
      status: OrderStatus,
      customerMobile: StoredMobile,
      payerMobile: StoredMobile.nullable(),
      mealType: MealType,
      serviceDate: IsoDate,
      itemName: Text(100),
      qty: Count,
      spice: Spice,
      foodPaise: Paise,
      foodDiscountPaise: Paise,
      deliveryPaise: Paise,
      platformFeePaise: Paise,
      totalPaise: Paise,
      gatewayTxnId: Text(100).nullable(),
      channel: ChannelEnum,
      fulfillmentMode: Text(16),
      deliveryTargetAddress: Text(2000),
      settlementHold: z.boolean(),
      createdAt: Timestamp,
      updatedAt: Timestamp,
    }),
    cook: z
      .object({ id: Uuid, kitchenName: Text(100), slugHandle: Text(50), mobileNumber: StoredMobile })
      .nullable(),
    checkout: z
      .object({
        checkoutId: Text(20),
        lines: z
          .array(
            z.object({
              id: Id,
              publicId: Text(20),
              status: OrderStatus,
              serviceDate: IsoDate,
              mealType: MealType,
              itemName: Text(100),
              qty: Count,
              totalPaise: Paise,
              traceId: Text(40),
            }),
          )
          .max(31),
      })
      .nullable(),
    payments: z
      .array(
        z.object({
          id: Id,
          orderId: Id,
          kind: z.enum(["CHARGE", "REFUND"]),
          status: Text(32),
          amountPaise: Paise,
          gatewayTxnId: Text(100).nullable(),
          createdAt: Timestamp,
        }),
      )
      .max(500),
    outbox: z.array(OutboxSummary).max(40),
    cloudLogging: z.object({
      byTraceId: Text(200),
      byPublicId: Text(200),
      byCheckoutId: Text(200).nullable(),
    }),
    activity: z
      .array(
        z.object({
          source: z.enum(["ledger", "payment", "admin", "outbox"]),
          id: Text(40),
          at: Timestamp,
          orderId: Id.nullable(),
          eventName: Text(200),
          channel: Text(40),
          actor: Text(80).nullable(),
          payload: JsonObject.nullable(),
        }),
      )
      .max(5000),
  })
  .describe("Ops support bundle");

const AdminSettlementRow = z.object({
  id: Id,
  businessDate: IsoDate,
  cookId: Uuid,
  kitchenName: Text(100),
  cookSlug: Text(50).nullable(),
  cookMobile: StoredMobile.nullable(),
  payoutUpiId: Text(80).nullable(),
  payoutAccountNote: Text(2000).nullable(),
  payoutBeneficiaryRef: Text(80).nullable(),
  grossPaise: PaiseTotal,
  feesPaise: PaiseTotal,
  clawbackPaise: PaiseTotal,
  pendingClawbackPaise: PaiseTotal,
  netPaise: PaiseTotal,
  orderCount: Count,
  status: Text(32),
  gatewayBatchId: Text(100).nullable(),
  manualPaidAt: Timestamp.nullable(),
  manualUtr: Text(80).nullable(),
  manualNote: Text(2000).nullable(),
  needsManualPay: z.boolean(),
  ageDays: Count,
  overdue: z.boolean(),
  createdAt: Timestamp,
});

/** runEodSettlement result (also returned by POST /internal/settlements/eod). */
export const EodSettlementResult = z
  .object({
    businessDate: IsoDate,
    batches: z.array(SettlementRow).max(5000),
    skipped: z
      .array(
        z.object({
          cookId: Uuid,
          businessDate: IsoDate.optional(),
          settlementId: Id.optional(),
          reason: z.enum(["zero_net", "already_claimed", "missing_manual_payout_details", "transfer_failed"]),
          error: Text(2000).optional(),
        }),
      )
      .max(5000),
    orderCount: Count,
  })
  .describe("EOD settlement run");

const TurnoverCount = z.number().int().min(0).max(100_000_000);
const TurnoverReport = z
  .object({
    range: z.object({
      from: IsoDate,
      to: IsoDate,
      period: z.enum(["week", "month", "year", "custom"]),
      label: Text(100),
    }),
    purpose: Text(500),
    definitions: z.object({
      foodGmvPaise: Text(300),
      platformFeePaise: Text(300),
      settledNetPaise: Text(300),
      commissionPaise: Text(300),
      gmvStatuses: z.array(OrderStatus).max(20),
    }),
    platform: z.object({
      foodGmvPaise: PaiseTotal,
      deliveryPaise: PaiseTotal,
      platformFeePaise: PaiseTotal,
      customerChargePaise: PaiseTotal,
      plates: TurnoverCount,
      orderCount: TurnoverCount,
      refundedFoodPaise: PaiseTotal,
      settledNetPaise: PaiseTotal,
      commissionPaise: PaiseTotal,
      cookCountWithVolume: TurnoverCount,
    }),
    liveCookCount: TurnoverCount,
    cooks: z
      .array(
        z.object({
          cookId: Uuid,
          kitchenName: Text(100),
          slugHandle: Text(50),
          onboardingStatus: Text(32),
          isActive: z.boolean(),
          pinCode: Text(6).nullable(),
          payoutBeneficiaryRef: Text(80).nullable(),
          payoutUpiId: Text(80).nullable(),
          foodGmvPaise: PaiseTotal,
          deliveryPaise: PaiseTotal,
          platformFeePaise: PaiseTotal,
          customerChargePaise: PaiseTotal,
          plates: TurnoverCount,
          orderCount: TurnoverCount,
          deliveredOrderCount: TurnoverCount,
          heldOrderCount: TurnoverCount,
          refundedFoodPaise: PaiseTotal,
          refundedOrderCount: TurnoverCount,
          settledNetPaise: PaiseTotal,
          commissionPaise: PaiseTotal,
          settledOrderCount: TurnoverCount,
          manualPaidPaise: PaiseTotal,
          transferCompletedPaise: PaiseTotal,
        }),
      )
      .max(10_000),
  })
  .describe("Turnover report");

const FeatureFlags = z
  .object({
    flags: z
      .array(
        z.object({
          key: Text(64),
          label: Text(120),
          description: Text(2000),
          enabled: z.boolean(),
          updatedAt: Timestamp.nullable(),
          updatedBy: Text(80).nullable(),
        }),
      )
      .max(100),
  })
  .describe("Feature flags (admin view)");

const Pricing = z
  .object({
    platformFeePaise: Paise,
    cookCommissionBps: Bps,
    maxPlatformFeePaise: Paise,
    maxCookCommissionBps: Bps,
    updatedAt: Timestamp.nullable(),
    updatedBy: Text(80).nullable(),
  })
  .describe("Platform fee + default cook commission");

const Tags = ["Admin"];

export const adminOperations = defineOperations([
  {
    method: "get",
    path: "/admin/tickets",
    operationId: "adminListTickets",
    summary: "List support tickets (newest first)",
    tags: Tags,
    access: "admin",
    response: z.array(SupportTicketRow).max(100_000),
  },
  {
    method: "get",
    path: "/admin/orders",
    operationId: "adminSearchOrders",
    summary: "Browse / filter orders by mobile, kitchen, service date, status",
    tags: Tags,
    access: "admin",
    query: AdminOrdersQuery,
    response: z.object({ count: Count, orders: z.array(OrderListRow).max(100) }),
    errors: { 404: "Kitchen not found" },
  },
  {
    method: "get",
    path: "/admin/orders-attention",
    operationId: "adminListAttentionOrders",
    summary: "Ops queue: cancel asks, stuck payments, logistics exceptions",
    tags: Tags,
    access: "admin",
    query: AdminAttentionQuery,
    response: z.object({
      count: Count,
      orders: z.array(OrderListRow.extend({ reason: Text(60) })).max(80),
    }),
  },
  {
    method: "get",
    path: "/admin/orders/:publicId",
    operationId: "adminGetOrderSupportBundle",
    summary: "Order + payments + outbox + activity timeline (key: publicId, checkoutId, traceId or gateway txn id)",
    tags: Tags,
    access: "admin",
    params: AdminOrderKeyParams,
    response: SupportBundle,
  },
  {
    method: "get",
    path: "/admin/tickets/:id",
    operationId: "adminGetTicket",
    summary: "Support ticket with its order and kitchen",
    tags: Tags,
    access: "admin",
    params: AdminIdParams,
    response: SupportTicketRow.extend({
      order: OrderRow.nullable(),
      cook: TicketCook.nullable(),
    }),
  },
  {
    method: "patch",
    path: "/admin/tickets/:id",
    operationId: "adminUpdateTicket",
    summary: "Change ticket category / status",
    tags: Tags,
    access: "admin",
    params: AdminIdParams,
    body: AdminTicketPatchBody,
    response: SupportTicketRow,
  },
  {
    method: "post",
    path: "/admin/cooks/:id/payout-details",
    operationId: "adminSetCookPayoutDetails",
    summary: "Set manual UPI / bank details, Route account, pickup options for a cook",
    tags: Tags,
    access: "admin",
    params: AdminCookIdParams,
    body: AdminPayoutDetailsBody,
    response: CookProfileRow,
  },
  {
    method: "get",
    path: "/admin/settlements",
    operationId: "adminListSettlements",
    summary: "Settlements needing manual pay (open) or full history (all)",
    tags: Tags,
    access: "admin",
    query: AdminSettlementsQuery,
    response: z.array(AdminSettlementRow).max(200),
  },
  {
    method: "post",
    path: "/admin/settlements/:id/manual-pay",
    operationId: "adminMarkSettlementPaid",
    summary: "Mark a settlement paid via UPI / bank (records UTR, notifies cook)",
    tags: Tags,
    access: "admin",
    params: AdminIdParams,
    body: AdminManualPayBody,
    response: SettlementRow,
  },
  {
    method: "post",
    path: "/admin/settlements/run-eod",
    operationId: "adminRunEodSettlement",
    summary: "Run end-of-day settlement now (today's business date)",
    tags: Tags,
    access: "admin",
    body: z.object({}).describe("No body fields"),
    response: EodSettlementResult,
  },
  {
    method: "post",
    path: "/admin/outbox/:id/retry",
    operationId: "adminRetryOutbox",
    summary: "Re-queue a parked or flag-skipped outbox row and wake push workers",
    tags: Tags,
    access: "admin",
    params: AdminIdParams,
    body: z.object({}).describe("No body fields"),
    response: z.object({
      ok: z.literal(true),
      id: Id,
      eventName: Text(120),
    }),
    errors: { 400: "Invalid outbox id", 404: "Outbox row not found" },
  },
  {
    method: "get",
    path: "/admin/cooks",
    operationId: "adminListCooks",
    summary: "All kitchens (pending applications first)",
    tags: Tags,
    access: "admin",
    response: z.array(CookProfileRow).max(100_000),
  },
  {
    method: "post",
    path: "/admin/cooks/:id/approve",
    operationId: "adminApproveCook",
    summary: "Approve a kitchen LIVE (requires FSSAI + payout details); WhatsApps the cook",
    tags: Tags,
    access: "admin",
    params: AdminCookIdParams,
    body: z.object({}).describe("No body fields"),
    response: CookProfileRow,
  },
  {
    method: "get",
    path: "/admin/analytics/turnover",
    operationId: "adminGetTurnoverReport",
    summary: "Route / RBI turnover report for week, month, year or custom range",
    tags: Tags,
    access: "admin",
    query: AdminTurnoverQuery,
    response: TurnoverReport,
  },
  {
    method: "get",
    path: "/admin/features",
    operationId: "adminListFeatureFlags",
    summary: "Platform feature flags with labels and audit info",
    tags: Tags,
    access: "admin",
    response: FeatureFlags,
  },
  {
    method: "patch",
    path: "/admin/features/:key",
    operationId: "adminSetFeatureFlag",
    summary: "Turn a platform feature flag on or off",
    tags: Tags,
    access: "admin",
    params: AdminFeatureKeyParams,
    body: AdminFeatureBody,
    response: FeatureFlags,
  },
  {
    method: "get",
    path: "/admin/pricing",
    operationId: "adminGetPricing",
    summary: "Platform fee and default cook commission",
    tags: Tags,
    access: "admin",
    response: Pricing,
  },
  {
    method: "patch",
    path: "/admin/pricing",
    operationId: "adminSetPricing",
    summary: "Change platform fee and/or default cook commission (applies to new orders only)",
    tags: Tags,
    access: "admin",
    body: AdminPricingBody,
    response: Pricing,
  },
  {
    method: "post",
    path: "/admin/cooks/:id/commission",
    operationId: "adminSetCookCommission",
    summary: "Set or clear a per-cook commission override (applies to new orders only)",
    tags: Tags,
    access: "admin",
    params: AdminCookIdParams,
    body: AdminCookCommissionBody,
    response: CookProfileRow,
    errors: { 404: "Cook not found" },
  },
  {
    method: "get",
    path: "/admin/ads",
    operationId: "adminListAdCampaigns",
    summary: "Ad campaigns (optionally for one PIN code)",
    tags: Tags,
    access: "admin",
    query: AdminAdsQuery,
    response: z.object({ adsEnabled: z.boolean(), campaigns: z.array(AdCampaign).max(100) }),
  },
  {
    method: "post",
    path: "/admin/ads",
    operationId: "adminUpsertAdCampaign",
    summary: "Create or update an ad campaign",
    tags: Tags,
    access: "admin",
    body: AdminAdUpsertBody,
    response: z.object({ campaign: AdCampaign }),
    errors: { 404: "Campaign not found" },
  },
  {
    method: "patch",
    path: "/admin/ads/:id/status",
    operationId: "adminSetAdCampaignStatus",
    summary: "Change an ad campaign's status",
    tags: Tags,
    access: "admin",
    params: AdminIdParams,
    body: AdminAdStatusBody,
    response: z.object({ campaign: AdCampaign }),
  },
]);
