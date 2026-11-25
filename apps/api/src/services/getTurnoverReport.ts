import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { cookProfiles, orders, settlements, type Db } from "@localmeals/db";
import {
  aggregateTurnoverFromRows,
  GMV_STATUSES,
  resolveTurnoverRange,
  type TurnoverPeriod,
} from "./turnoverReports.js";

const REFUNDED = "REFUNDED" as const;

/**
 * Route / RBI-oriented turnover: aggregates paid orders + settlements by cook
 * for week / month / year (or custom from–to).
 */
export async function getTurnoverReport(
  db: Db,
  input: {
    period: TurnoverPeriod;
    from?: string;
    to?: string;
    cookId?: string;
  },
) {
  const range = resolveTurnoverRange(input);
  const cookFilter = input.cookId?.trim() || null;

  const orderRows = await db
    .select({
      cookId: orders.cookId,
      foodPaise: orders.foodPaise,
      foodDiscountPaise: orders.foodDiscountPaise,
      deliveryPaise: orders.deliveryPaise,
      platformFeePaise: orders.platformFeePaise,
      qty: orders.qty,
      status: orders.status,
      settlementHold: orders.settlementHold,
    })
    .from(orders)
    .where(
      and(
        gte(orders.serviceDate, range.from),
        lte(orders.serviceDate, range.to),
        cookFilter ? eq(orders.cookId, cookFilter) : undefined,
        inArray(orders.status, [...GMV_STATUSES, REFUNDED]),
      ),
    );

  const settleRows = await db
    .select({
      cookId: settlements.cookId,
      netPaise: settlements.netPaise,
      feesPaise: settlements.feesPaise,
      orderCount: settlements.orderCount,
      status: settlements.status,
      manualPaidAt: settlements.manualPaidAt,
    })
    .from(settlements)
    .where(
      and(
        gte(settlements.businessDate, range.from),
        lte(settlements.businessDate, range.to),
        cookFilter ? eq(settlements.cookId, cookFilter) : undefined,
      ),
    );

  const cookIds = [
    ...new Set([...orderRows.map((o) => o.cookId), ...settleRows.map((s) => s.cookId)]),
  ];
  const cooks = cookIds.length
    ? await db.query.cookProfiles.findMany({
        where: (t, { inArray: ia }) => ia(t.id, cookIds),
      })
    : [];

  const { cooks: cooksOut, platform } = aggregateTurnoverFromRows(
    orderRows,
    settleRows,
    cooks.map((c) => ({
      id: c.id,
      kitchenName: c.kitchenName,
      slugHandle: c.slugHandle,
      onboardingStatus: c.onboardingStatus,
      isActive: c.isActive,
      pinCode: c.pinCode,
      payoutBeneficiaryRef: c.payoutBeneficiaryRef,
      payoutUpiId: c.payoutUpiId,
    })),
  );

  const liveCooks = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(cookProfiles)
    .where(eq(cookProfiles.onboardingStatus, "LIVE"));

  return {
    range,
    purpose:
      "Route / connected-account turnover — food GMV from paid orders by service date; settlements by business date. Export for RBI / Razorpay reviews.",
    definitions: {
      foodGmvPaise: "Sum of (food×qty − food discount) on paid-pipeline orders",
      platformFeePaise: "Customer platform fee (admin-set) once per checkout (stored on first day-line for week carts)",
      settledNetPaise: "Settlement net_paise in window (cook food owed / paid)",
      commissionPaise: "Cook commission deducted in settlements in window (settlements.fees_paise)",
      gmvStatuses: GMV_STATUSES,
    },
    platform,
    liveCookCount: liveCooks[0]?.n ?? 0,
    cooks: cooksOut,
  };
}
