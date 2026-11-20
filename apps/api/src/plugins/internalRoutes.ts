import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@localmeals/db";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";
import { assertInternalOrRoles } from "../services/internalAuth.js";
import { runMealCutoff } from "../services/cookOps.js";
import { runEodSettlement } from "../services/settlement.js";
import { purgeExpiredPii, redactOldLedgerMobiles } from "../services/retention.js";
import { holdSettlement, refundOrder, adminPauseCook } from "../services/admin.js";

const mealTypeSchema = z.enum(["BREAKFAST", "LUNCH", "DINNER"]);

export async function internalRoutes(
  app: FastifyInstance,
  opts: { db: Db,
  auth: AuthHelpers },
) {
  const { db, auth } = opts;
  const { currentUser, assertAuthed, assertKitchenStaff, assertOrderKitchenStaff, bindCustomerMobile } = auth;
app.post("/internal/cutoffs/:mealType", async (req, reply) => {
  let authz: Awaited<ReturnType<typeof assertInternalOrRoles>>;
  try {
    authz = await assertInternalOrRoles(db, req.headers, ["ADMIN", "COOK"]);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
  const { mealType: raw } = req.params as { mealType: string };
  const parsed = mealTypeSchema.safeParse(raw.toUpperCase());
  if (!parsed.success) return reply.code(400).send({ error: "mealType must be BREAKFAST|LUNCH|DINNER" });
  const body = z
    .object({
      cookId: z.string().uuid().optional(),
      force: z.boolean().optional(),
    })
    .parse(req.body ?? {});

  // COOK may only cut off their own kitchen — never global / other cooks / force.
  if (authz.kind === "session" && authz.user.role === "COOK") {
    if (!authz.user.cookId) {
      return reply.code(403).send({ error: "Not your kitchen" });
    }
    return runMealCutoff(db, parsed.data, { cookId: authz.user.cookId, force: false });
  }

  return runMealCutoff(db, parsed.data, body);
});

app.post("/internal/settlements/eod", async (req, reply) => {
  try {
    await assertInternalOrRoles(db, req.headers, ["ADMIN"]);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
  return runEodSettlement(db);
});

/** Purge expired OTP/sessions/rate buckets + old ledger PII. Scheduler or ADMIN. */
app.post("/internal/ops/retention", async (req, reply) => {
  try {
    await assertInternalOrRoles(db, req.headers, ["ADMIN"]);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
  const body = z
    .object({
      mode: z.enum(["purge", "redact"]).optional(),
    })
    .parse(req.body ?? {});
  if (body.mode === "redact") {
    return redactOldLedgerMobiles(db);
  }
  return purgeExpiredPii(db);
});

app.post("/internal/ops/holds", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const body = z.object({ orderId: z.number(), reason: z.string() }).parse(req.body);
    return holdSettlement(db, body.orderId, body.reason);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/internal/ops/refunds", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const body = z
      .object({
        orderId: z.number(),
        mode: z.enum(["FULL", "FOOD_ONLY"]),
        reason: z.string(),
        ticketId: z.number().optional(),
      })
      .parse(req.body);
    return refundOrder(db, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/internal/ops/cooks/:id/pause", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string() }).parse(req.body);
    return adminPauseCook(db, id, body.reason);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});
}
