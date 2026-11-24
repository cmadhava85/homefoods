import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import { Count, Id, IsoDate, MealType, Paise, Text, Url, Uuid } from "../openapi/shared.js";
import { CookProfileRow, OrderRow } from "./adminShared.contract.js";
import { EodSettlementResult } from "./adminRoutes.contract.js";

export const CutoffParams = z.object({
  mealType: z
    .string()
    .max(10)
    .regex(/^(breakfast|lunch|dinner)$/i)
    .describe("BREAKFAST | LUNCH | DINNER (case-insensitive)"),
});
export const CutoffBody = z
  .object({
    cookId: Uuid.optional().describe("Only this kitchen (ignored for COOK sessions)"),
    force: z.boolean().optional().describe("Lock even before the kitchen's cut-off (ADMIN / scheduler)"),
  })
  .describe("Cut-off options");
export const EodBody = z
  .object({ businessDate: IsoDate.optional() })
  .describe("Settlement business date (default: today IST)");
export const RetentionBody = z
  .object({ mode: z.enum(["purge", "redact"]).optional() })
  .describe("purge (default) deletes expired PII; redact masks old ledger mobiles");
export const HoldBody = z.object({ orderId: Id, reason: Text(500) }).describe("Hold an order from settlement");
export const OpsRefundBody = z
  .object({
    orderId: Id,
    mode: z.enum(["FULL", "FOOD_ONLY"]),
    reason: Text(500),
    ticketId: Id.optional(),
  })
  .describe("Refund an order line");
export const PauseCookParams = z.object({ id: Uuid.describe("Cook id") });
export const PauseCookBody = z.object({ reason: Text(500) }).describe("Why the kitchen is paused");

const UnpaidExpired = z.object({ asOfDate: IsoDate, scanned: Count, cancelled: Count });

const CutoffResult = z.object({
  serviceDate: IsoDate,
  mealType: MealType,
  results: z
    .array(
      z.object({
        cookId: Uuid,
        slugHandle: Text(50),
        mealType: MealType.optional(),
        headcount: Count.optional(),
        skipped: z.boolean().optional(),
        reason: Text(200).optional(),
        routeMapsUrl: Url.nullable().optional(),
        cutoff: Text(20).optional(),
        lunchCutoff: Text(20).optional(),
      }),
    )
    .max(1000),
  unpaidExpired: UnpaidExpired,
});

const Clawback = z.object({
  created: z.boolean(),
  amountPaise: Paise,
  entryId: Id.optional(),
});

export const internalOperations = defineOperations([
  {
    method: "post",
    path: "/internal/cutoffs/:mealType",
    operationId: "runMealCutoff",
    summary: "Lock orders at cut-off and send the cook headcount (Cloud Scheduler, ADMIN, or a COOK for own kitchen)",
    tags: ["Internal jobs"],
    access: "internal",
    params: CutoffParams,
    body: CutoffBody,
    response: CutoffResult,
  },
  {
    method: "post",
    path: "/internal/settlements/eod",
    operationId: "runEodSettlementJob",
    summary: "End-of-day cook settlement batch (Cloud Scheduler or ADMIN)",
    tags: ["Internal jobs"],
    access: "internal",
    body: EodBody,
    response: EodSettlementResult,
  },
  {
    method: "post",
    path: "/internal/ops/expire-unpaid",
    operationId: "expireUnpaidOrders",
    summary: "Expire unpaid holds and past-service-date unpaid orders",
    tags: ["Internal jobs"],
    access: "internal",
    body: z.object({}).describe("No body fields"),
    response: UnpaidExpired,
  },
  {
    method: "post",
    path: "/internal/ops/retention",
    operationId: "runRetention",
    summary: "Purge expired OTPs/sessions/rate buckets/old ledger rows, or redact old ledger mobiles",
    tags: ["Internal jobs"],
    access: "internal",
    body: RetentionBody,
    response: z.object({
      ok: z.literal(true),
      retentionDays: Count,
      deleted: z
        .object({
          platformEventLedger: Count,
          authOtps: Count,
          authRevocations: Count,
          waCheckoutSessions: Count,
          outboxProcessed: Count,
          rateLimitBuckets: Count,
        })
        .optional()
        .describe("purge mode"),
      updated: Count.optional().describe("redact mode"),
    }),
  },
  {
    method: "post",
    path: "/internal/ops/holds",
    operationId: "holdOrderSettlement",
    summary: "Admin: exclude an order from cook settlement",
    tags: ["Internal jobs"],
    access: "admin",
    body: HoldBody,
    response: OrderRow,
  },
  {
    method: "post",
    path: "/internal/ops/refunds",
    operationId: "opsRefundOrder",
    summary: "Admin: refund an order line (FULL or FOOD_ONLY)",
    tags: ["Internal jobs"],
    access: "admin",
    body: OpsRefundBody,
    response: OrderRow.extend({ clawback: Clawback.optional() }),
  },
  {
    method: "post",
    path: "/internal/ops/cooks/:id/pause",
    operationId: "pauseCook",
    summary: "Admin: pause a kitchen (stops new orders)",
    tags: ["Internal jobs"],
    access: "admin",
    params: PauseCookParams,
    body: PauseCookBody,
    response: CookProfileRow,
  },
]);
