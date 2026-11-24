import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { customerCredits, orders, type DbOrTx } from "@localmeals/db";
import {
  GATEWAY_FEE_BPS,
  lineFoodNetPaise,
  priceCheckoutLines,
  type PaymentMethod,
} from "@localmeals/domain";

/**
 * Credit held by unpaid lines. FAILED stays held because a late capture can still mark it PAID;
 * the hold ends when the line is CANCELLED or expires — no cancel path has to give credit back.
 */
const HOLDING_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "AWAITING_PAYMENT",
  "CONFIRMING_PAYMENT",
  "FAILED",
] as const;

/** Spendable credit = ledger sum − credit held by unpaid lines. */
export async function creditBalancePaise(db: DbOrTx, mobile: string): Promise<number> {
  const [ledger] = await db
    .select({ total: sql<number>`coalesce(sum(${customerCredits.amountPaise}), 0)::int` })
    .from(customerCredits)
    .where(eq(customerCredits.customerMobile, mobile));
  const [held] = await db
    .select({ total: sql<number>`coalesce(sum(${orders.creditAppliedPaise}), 0)::int` })
    .from(orders)
    .where(
      and(eq(orders.customerMobile, mobile), inArray(orders.status, [...HOLDING_STATUSES])),
    );
  return Math.max(0, Number(ledger?.total ?? 0) - Number(held?.total ?? 0));
}

/** Serialise credit spend per customer for the rest of the transaction. */
export async function lockCustomerCredit(tx: DbOrTx, mobile: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`credit:${mobile}`}))`);
}

function feeBps(method: PaymentMethod): number {
  if (method === "CREDIT") return 0;
  const env = Number(process.env[`CONVENIENCE_FEE_BPS_${method}`]);
  return Number.isFinite(env) && env >= 0 && env < 10_000 ? env : GATEWAY_FEE_BPS[method];
}

export type CheckoutPricingOptions = {
  useCredit: boolean;
  feeEnabled: boolean;
  paymentMethod: Exclude<PaymentMethod, "CREDIT">;
};

export async function checkoutPricingOptions(
  db: DbOrTx,
  input: { useCredit?: boolean; paymentMethod?: "LINK" | "UPI_QR"; fulfillmentMode?: string },
): Promise<CheckoutPricingOptions> {
  const { getFeatureFlags } = await import("./featureFlags.js");
  const flags = await getFeatureFlags(db as never);
  const qrAllowed = flags.upi_qr_pickup_enabled === true && input.fulfillmentMode === "PICKUP";
  return {
    useCredit: flags.wallet_credit_enabled === true && input.useCredit !== false,
    feeEnabled: flags.convenience_fee_enabled === true,
    paymentMethod: input.paymentMethod === "UPI_QR" && qrAllowed ? "UPI_QR" : "LINK",
  };
}

/**
 * Inside the order-insert transaction (after lockCustomerCredit): per-line credit + fee.
 * `bases` are line totals before fee (food net + delivery + platform fee).
 */
export async function priceLinesForCustomer(
  tx: DbOrTx,
  mobile: string,
  bases: number[],
  opts: CheckoutPricingOptions,
) {
  const available = opts.useCredit ? await creditBalancePaise(tx, mobile) : 0;
  const priced = priceCheckoutLines(bases, {
    creditAvailablePaise: available,
    feeBps: opts.feeEnabled ? feeBps(opts.paymentMethod) : 0,
  });
  const gatewayTotal = priced.reduce((s, p) => s + p.gatewayPaise, 0);
  const method: PaymentMethod = gatewayTotal === 0 ? "CREDIT" : opts.paymentMethod;
  return { priced, gatewayTotal, method };
}

/** Line base before fee/credit, used when building lines. */
export function lineBasePaise(o: {
  foodPaise: number;
  qty: number;
  foodDiscountPaise?: number | null;
  deliveryPaise: number;
  platformFeePaise: number;
}) {
  return lineFoodNetPaise(o) + o.deliveryPaise + o.platformFeePaise;
}

export async function addCredit(
  tx: DbOrTx,
  input: { mobile: string; amountPaise: number; reason: string; orderId?: number; key: string },
) {
  if (input.amountPaise === 0) return;
  await tx
    .insert(customerCredits)
    .values({
      customerMobile: input.mobile,
      amountPaise: input.amountPaise,
      reason: input.reason.slice(0, 40),
      orderId: input.orderId ?? null,
      idempotencyKey: input.key.slice(0, 120),
    })
    .onConflictDoNothing();
}

/** On PAID: turn the line's hold into a ledger debit (idempotent per line). */
export async function debitCreditForPaidLine(
  tx: DbOrTx,
  line: { id: number; customerMobile: string; creditAppliedPaise: number },
) {
  if (line.creditAppliedPaise <= 0) return;
  await addCredit(tx, {
    mobile: line.customerMobile,
    amountPaise: -line.creditAppliedPaise,
    reason: "ORDER_PAID",
    orderId: line.id,
    key: `spend_${line.id}`,
  });
}

export async function creditSummary(db: DbOrTx, mobile: string) {
  const entries = await db
    .select({
      id: customerCredits.id,
      amountPaise: customerCredits.amountPaise,
      reason: customerCredits.reason,
      orderId: customerCredits.orderId,
      createdAt: customerCredits.createdAt,
    })
    .from(customerCredits)
    .where(eq(customerCredits.customerMobile, mobile))
    .orderBy(desc(customerCredits.id))
    .limit(50);
  return {
    balancePaise: await creditBalancePaise(db, mobile),
    entries: entries.map((e) => ({ ...e, createdAt: new Date(e.createdAt).toISOString() })),
  };
}
