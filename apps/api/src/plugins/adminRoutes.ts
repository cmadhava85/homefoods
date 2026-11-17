import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@localmeals/db";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";
import {
  adminApproveCook,
  adminMarkSettlementManualPaid,
  adminSetCookPayoutDetails,
  adminUpdateTicket,
  getTicket,
  listCooks,
  listSettlementsForAdmin,
  listTickets,
} from "../services/admin.js";
import { runEodSettlement } from "../services/settlement.js";
import { getTurnoverReport } from "../services/getTurnoverReport.js";

export async function adminRoutes(
  app: FastifyInstance,
  opts: { db: Db,
  auth: AuthHelpers },
) {
  const { db, auth } = opts;
  const { currentUser, assertAuthed, assertKitchenStaff, assertOrderKitchenStaff, bindCustomerMobile } = auth;
app.get("/admin/tickets", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    return listTickets(db);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});
app.get("/admin/tickets/:id", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const id = Number((req.params as { id: string }).id);
    const ticket = await getTicket(db, id);
    if (!ticket) return reply.code(404).send({ error: "Not found" });
    return ticket;
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/admin/tickets/:id", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const id = Number((req.params as { id: string }).id);
    const body = z
      .object({
        category: z
          .enum([
            "MISSING_DELIVERY",
            "QUALITY",
            "WRONG_ITEM",
            "PAYMENT",
            "FOODBORNE",
            "COOK_OPS",
            "DELAY",
            "DOOR_NO_ANSWER",
            "OTHER",
          ])
          .optional(),
        status: z.enum(["OPEN", "RESOLVED", "CLOSED"]).optional(),
      })
      .parse(req.body ?? {});
    return await adminUpdateTicket(db, id, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

/** Manual UPI/bank details + optional Route acc for a cook. */
app.post("/admin/cooks/:id/payout-details", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        payoutUpiId: z.string().nullable().optional(),
        payoutAccountNote: z.string().nullable().optional(),
        payoutBeneficiaryRef: z.string().nullable().optional(),
        pickupLandmark: z.string().nullable().optional(),
        pickupEnabled: z.boolean().optional(),
      })
      .parse(req.body);
    return await adminSetCookPayoutDetails(db, id, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/admin/settlements", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const q = req.query as { filter?: string };
    const filter = q.filter === "all" ? "all" : "open";
    return await listSettlementsForAdmin(db, { filter });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/admin/settlements/:id/manual-pay", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "Invalid settlement id" });
    const body = z
      .object({
        utr: z.string().min(4),
        note: z.string().optional(),
      })
      .parse(req.body);
    return await adminMarkSettlementManualPaid(db, id, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/admin/settlements/run-eod", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    return await runEodSettlement(db);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/admin/cooks", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    return listCooks(db);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/admin/cooks/:id/approve", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const { id } = req.params as { id: string };
    return await adminApproveCook(db, id);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});


/** Route / RBI turnover: week | month | year | custom (from & to). */
app.get("/admin/analytics/turnover", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const q = z
      .object({
        period: z.enum(["week", "month", "year", "custom"]).default("month"),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        cookId: z.string().uuid().optional(),
      })
      .parse(req.query ?? {});
    return await getTurnoverReport(db, q);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/admin/features", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const { listFeatureFlagsForAdmin } = await import("../services/featureFlags.js");
    return { flags: await listFeatureFlagsForAdmin(db) };
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/admin/features/:key", async (req, reply) => {
  try {
    const user = assertAuthed(req, ["ADMIN"]);
    const { key } = req.params as { key: string };
    const body = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    const { setFeatureFlag } = await import("../services/featureFlags.js");
    const flags = await setFeatureFlag(db, {
      key,
      enabled: body.enabled,
      actor: user?.mobile ?? "admin",
    });
    return { flags };
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});
}
