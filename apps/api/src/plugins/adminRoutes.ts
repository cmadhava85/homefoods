import type { FastifyInstance } from "fastify";
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
  logAdmin,
} from "../services/admin.js";
import { runEodSettlement } from "../services/settlement.js";
import { getTurnoverReport } from "../services/getTurnoverReport.js";
import {
  AdminAdStatusBody,
  AdminAdUpsertBody,
  AdminAdsQuery,
  AdminAttentionQuery,
  AdminCookCommissionBody,
  AdminCookIdParams,
  AdminFeatureBody,
  AdminFeatureKeyParams,
  AdminIdParams,
  AdminManualPayBody,
  AdminOrderKeyParams,
  AdminOrdersQuery,
  AdminPayoutDetailsBody,
  AdminPricingBody,
  AdminSettlementsQuery,
  AdminTicketPatchBody,
  AdminTurnoverQuery,
} from "./adminRoutes.contract.js";

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

/**
 * Browse / filter orders (mobile, cook, date, status). Register before :publicId.
 */
app.get("/admin/orders", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const q = AdminOrdersQuery.parse(req.query ?? {});
    const { searchAdminOrders } = await import("../services/orderActivity.js");
    return await searchAdminOrders(db, q);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

/** Ops queue: cancel asks, stuck payments, logistics exceptions. */
app.get("/admin/orders-attention", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const q = AdminAttentionQuery.parse(req.query ?? {});
    const { listAdminAttentionOrders } = await import("../services/orderActivity.js");
    return await listAdminAttentionOrders(db, q.limit);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

/**
 * Ops support: order + payments + outbox + activity timeline.
 * `:key` accepts publicId (LM-…), checkoutId, traceId (trc_…), or gatewayTxnId.
 */
app.get("/admin/orders/:publicId", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const { publicId: key } = AdminOrderKeyParams.parse(req.params);
    const { getOrderSupportBundle } = await import("../services/orderActivity.js");
    return await getOrderSupportBundle(db, key);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});
app.get("/admin/tickets/:id", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const id = Number(AdminIdParams.parse(req.params).id);
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
    const id = Number(AdminIdParams.parse(req.params).id);
    const body = AdminTicketPatchBody.parse(req.body ?? {});
    return await adminUpdateTicket(db, id, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

/** Manual UPI/bank details + optional Route acc for a cook. */
app.post("/admin/cooks/:id/payout-details", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const { id } = AdminCookIdParams.parse(req.params);
    const body = AdminPayoutDetailsBody.parse(req.body);
    return await adminSetCookPayoutDetails(db, id, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/admin/settlements", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const q = AdminSettlementsQuery.parse(req.query ?? {});
    const filter = q.filter === "all" ? "all" : "open";
    return await listSettlementsForAdmin(db, { filter });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/admin/settlements/:id/manual-pay", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const id = Number(AdminIdParams.parse(req.params).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "Invalid settlement id" });
    const body = AdminManualPayBody.parse(req.body);
    return await adminMarkSettlementManualPaid(db, id, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/admin/settlements/run-eod", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const result = await runEodSettlement(db);
    await logAdmin(db, "RUN_EOD", "settlement", result.businessDate ?? "today", "admin console", {
      orderCount: result.orderCount,
      batchCount: result.batches?.length,
    });
    return result;
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

/** Re-queue a parked / flag-skipped outbox row for another delivery attempt. */
app.post("/admin/outbox/:id/retry", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isFinite(id)) {
      return reply.code(400).send({ error: "Invalid outbox id" });
    }
    const { eq } = await import("drizzle-orm");
    const { outbox } = await import("@localmeals/db");
    const { logAdminAction } = await import("../services/admin.js");
    const [row] = await db
      .update(outbox)
      .set({
        processedAt: null,
        attempts: 0,
        lastError: null,
        lockedUntil: null,
      })
      .where(eq(outbox.id, id))
      .returning({ id: outbox.id, eventName: outbox.eventName });
    if (!row) return reply.code(404).send({ error: "Outbox row not found" });
    await logAdminAction(db, "OUTBOX_RETRY", "outbox", String(id), row.eventName);
    // Wake push-mode workers immediately (no-op when OUTBOX_WAKE_TOPIC unset / poll mode).
    const { outboxWaker } = await import("../services/outboxWake.js");
    outboxWaker().markDirty();
    void outboxWaker().flush();
    return { ok: true, id: row.id, eventName: row.eventName };
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
    const { id } = AdminCookIdParams.parse(req.params);
    return await adminApproveCook(db, id);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});


/** Route / RBI turnover: week | month | year | custom (from & to). */
app.get("/admin/analytics/turnover", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const q = AdminTurnoverQuery.parse(req.query ?? {});
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
    const { key } = AdminFeatureKeyParams.parse(req.params);
    const body = AdminFeatureBody.parse(req.body ?? {});
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

app.get("/admin/pricing", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const { getPricingForAdmin } = await import("../services/platformSettings.js");
    return await getPricingForAdmin(db);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/admin/pricing", async (req, reply) => {
  try {
    const user = assertAuthed(req, ["ADMIN"]);
    const body = AdminPricingBody.parse(req.body ?? {});
    const { setPlatformPricing } = await import("../services/platformSettings.js");
    return await setPlatformPricing(db, { ...body, actor: user?.mobile ?? "admin" });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/admin/cooks/:id/commission", async (req, reply) => {
  try {
    const user = assertAuthed(req, ["ADMIN"]);
    const { id } = AdminCookIdParams.parse(req.params);
    const body = AdminCookCommissionBody.parse(req.body ?? {});
    const { setCookCommission } = await import("../services/platformSettings.js");
    return await setCookCommission(db, {
      cookId: id,
      commissionBps: body.commissionBps,
      actor: user?.mobile ?? "admin",
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/admin/ads", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const q = AdminAdsQuery.parse(req.query ?? {});
    const { listAdCampaignsAdmin } = await import("../services/ads.js");
    return await listAdCampaignsAdmin(db, { pinCode: q.pin, limit: q.limit });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/admin/ads", async (req, reply) => {
  try {
    const user = assertAuthed(req, ["ADMIN"]);
    const body = AdminAdUpsertBody.parse(req.body ?? {});
    const { adminUpsertAdCampaign } = await import("../services/ads.js");
    const campaign = await adminUpsertAdCampaign(db, {
      ...body,
      startsAt: body.startsAt ? new Date(body.startsAt) : body.startsAt === null ? null : undefined,
      endsAt: body.endsAt ? new Date(body.endsAt) : body.endsAt === null ? null : undefined,
      actor: user?.mobile ?? "admin",
    });
    return { campaign };
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/admin/ads/:id/status", async (req, reply) => {
  try {
    assertAuthed(req, ["ADMIN"]);
    const { id } = AdminIdParams.parse(req.params);
    const body = AdminAdStatusBody.parse(req.body ?? {});
    const { adminSetAdCampaignStatus } = await import("../services/ads.js");
    const campaign = await adminSetAdCampaignStatus(db, Number(id), body.status);
    return { campaign };
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});
}
