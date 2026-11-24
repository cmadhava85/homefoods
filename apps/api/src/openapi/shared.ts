/**
 * Reusable, bounded zod building blocks for request/response contracts.
 * Every string has a maxLength (+ pattern/enum where the shape is known), every number has
 * min/max, every array has maxItems — the 42Crunch data-validation rules (see openapi.test.ts).
 */
import { z } from "zod";

export const Slug = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .describe("Kitchen slug, e.g. csk-homemade-delights");
/** LM- + uppercase hex (legacy digits also match). */
export const OrderPublicId = z
  .string()
  .min(4)
  .max(20)
  .regex(/^LM-[A-Za-z0-9]{1,17}$/)
  .describe("Order public id, e.g. LM-72A1417C34");
export const CheckoutId = z
  .string()
  .min(5)
  .max(20)
  .regex(/^CHK-[A-Za-z0-9]{1,16}$/)
  .describe("Week-cart checkout id, e.g. CHK-0F3A9B2C1D");
/** Order or checkout id (pages that accept either). */
export const OrderOrCheckoutId = z
  .string()
  .min(4)
  .max(20)
  .regex(/^(LM|CHK)-[A-Za-z0-9]{1,17}$/)
  .describe("Order (LM-…) or checkout (CHK-…) public id");
/** Accepts +91XXXXXXXXXX or local forms; normalised server-side. */
export const Mobile = z
  .string()
  .min(8)
  .max(20)
  .regex(/^\+?[0-9 -]{8,19}$/)
  .describe("Mobile number with country code, e.g. +919876543210");
export const IsoDate = z
  .string()
  .length(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date YYYY-MM-DD (Asia/Kolkata service day)");
export const IsoDateTime = z.string().max(40).describe("ISO-8601 timestamp");
export const PinCode = z.string().length(6).regex(/^\d{6}$/).describe("Indian PIN code");
export const MealType = z.enum(["BREAKFAST", "LUNCH", "DINNER"]).describe("Meal period");
export const Spice = z.enum(["NORMAL", "LESS"]).describe("Spice preference");
export const FulfillmentMode = z
  .enum(["DELIVERY", "PICKUP", "CUSTOMER_ARRANGE"])
  .describe("DELIVERY (cook/partner), PICKUP (customer collects), CUSTOMER_ARRANGE (customer's own courier)");
export const Role = z.enum(["CUSTOMER", "COOK", "ADMIN"]).describe("Account role");
export const OrderStatus = z
  .enum([
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
  ])
  .describe("Order lifecycle state");

export const Paise = z.number().int().min(0).max(100_000_000).describe("Amount in paise (₹1 = 100)");
export const Qty = z.number().int().min(1).max(50).describe("Plates");
export const Id = z.number().int().min(1).max(2_147_483_647).describe("Numeric id");
export const Count = z.number().int().min(0).max(1_000_000).describe("Count");
export const Uuid = z.string().uuid().max(36).describe("UUID");
export const Text = (max = 200) => z.string().max(max);
export const Url = z.string().max(2048).describe("URL");

/** Path param helpers — path params arrive as strings. */
export const IdParam = z.string().min(1).max(10).regex(/^\d+$/).describe("Numeric id");

export const Ok = z.object({ ok: z.literal(true) }).describe("Operation succeeded");
export const ErrorResponse = z
  .object({ error: z.string().max(1000).describe("Human-readable, localized error message") })
  .describe("Error");

/** Small scalar key/value map (feature flags etc.) — bounded keys and values. */
export const ScalarRecord = z
  .record(
    z.string().max(100),
    z.union([z.string().max(2000), z.number().min(-1e12).max(1e12), z.boolean(), z.null()]),
  )
  .describe("Key/value map");
