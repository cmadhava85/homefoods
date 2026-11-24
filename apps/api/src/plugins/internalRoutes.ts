import type { FastifyInstance } from "fastify";
import type { Db } from "@localmeals/db";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";
import { assertInternalOrRoles } from "../services/internalAuth.js";
import { runMealCutoff } from "../services/cookOps.js";
import { runEodSettlement } from "../services/settlement.js";
import { purgeExpiredPii, redactOldLedgerMobiles } from "../services/retention.js";
import { holdSettlement, refundOrder, adminPauseCook } from "../services/admin.js";
import { expireUnpaidOrdersPastServiceDate } from "../services/orders.js";

import {
  CutoffBody,
  CutoffParams,
  EodBody,
  HoldBody,
  OpsRefundBody,
  PauseCookBody,
  PauseCookParams,
  RetentionBody,
} from "./internalRoutes.contract.js";

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
  const parsed = CutoffParams.safeParse(req.params);
  if (!parsed.success) return reply.code(400).send({ error: "mealType must be BREAKFAST|LUNCH|DINNER" });
  const mealType = parsed.data.mealType.toUpperCase() as "BREAKFAST" | "LUNCH" | "DINNER";
  const body = CutoffBody.parse(req.body ?? {});

  // COOK may only cut off their own kitchen — never global / other cooks / force.
  if (authz.kind === "session" && authz.user.role === "COOK") {
    if (!authz.user.cookId) {
      return reply.code(403).send({ error: "Not your kitchen" });
    }
    return runMealCutoff(db, mealType, { cookId: authz.user.cookId, force: false });
  }

  return runMealCutoff(db, mealType, body);
});

app.post("/internal/settlements/eod", async (req, reply) => {
  try {
    await assertInternalOrRoles(db, req.headers, ["ADMIN"]);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
  const body = EodBody.parse(req.body ?? {});
  return runEodSettlement(db, body.businessDate);
});

/** Expire stale unpaid holds + past-service-date unpaid rows. */
app.post("/internal/ops/expire-unpaid", async (req, reply) => {
  try {
    await assertInternalOrRoles(db, req.headers, ["ADMIN"]);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
  return expireUnpaidOrdersPastServiceDate(db);
});

/** Purge expired OTP/sessions/rate buckets + old ledger PII. Scheduler or ADMIN. */
app.post("/internal/ops/retention", async (req, reply) => {
  try {
    await assertInternalOrRoles(db, req.headers, ["ADMIN"]);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
  const body = RetentionBody.parse(req.body ?? {});
  if (body.mode === "redact") {
    return redactOldLedgerMobiles(db);
  }
  return purgeExpiredPii(db);
});

app.post("/internal/ops/holds", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const body = HoldBody.parse(req.body);
    return holdSettlement(db, body.orderId, body.reason);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/internal/ops/refunds", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const body = OpsRefundBody.parse(req.body);
    return refundOrder(db, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/internal/ops/cooks/:id/pause", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const { id } = PauseCookParams.parse(req.params);
    const body = PauseCookBody.parse(req.body);
    return adminPauseCook(db, id, body.reason);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});
}
