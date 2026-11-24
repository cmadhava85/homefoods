import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import { Count, Id } from "../openapi/shared.js";

export const DeleteAccountBody = z.object({
  confirm: z.literal("DELETE").describe("Must be exactly DELETE to confirm erasure"),
});

const CreditEntry = z.object({
  id: Id,
  amountPaise: z.number().int().min(-10_000_000).max(10_000_000).describe("+credit / −spent"),
  reason: z.string().max(40),
  orderId: Id.nullable(),
  createdAt: z.string().max(40),
});

export const accountOperations = defineOperations([
  {
    method: "get",
    path: "/me/credits",
    operationId: "getMyCredits",
    summary: "LocalMeals credit balance (spendable; excludes credit held by unpaid orders) and recent entries",
    tags: ["Account"],
    access: "customer",
    response: z.object({
      balancePaise: z.number().int().min(0).max(10_000_000),
      entries: z.array(CreditEntry).max(50),
    }),
  },
  {
    method: "post",
    path: "/me/account/delete",
    operationId: "deleteMyAccount",
    summary:
      "Erase the signed-in customer's personal data (DPDP). Orders are kept anonymised for tax records; sessions are revoked.",
    tags: ["Account"],
    access: "customer",
    body: DeleteAccountBody,
    response: z.object({ ok: z.literal(true), anonymisedOrders: Count }),
    errors: { 409: "Kitchen owner, or orders still in progress" },
  },
]);
