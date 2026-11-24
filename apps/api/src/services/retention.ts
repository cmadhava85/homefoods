import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  adminActionLog,
  authOtps,
  authRevocations,
  outbox,
  platformEventLedger,
  supportTickets,
  waCheckoutSessions,
  type Db,
} from "@localmeals/db";
import { purgeExpiredRateLimitBuckets } from "./pgRateLimitStore.js";

/** Prefer ≥ 180 days so ledger survives Razorpay disputes (~120d) + buffer. */
function retentionDays() {
  const n = Number(process.env.PII_RETENTION_DAYS ?? 180);
  return Number.isFinite(n) && n >= 7 ? Math.floor(n) : 180;
}

/**
 * Purge stale PII-adjacent rows and ephemeral auth/rate-limit state.
 * Does **not** delete paid order history (financial records).
 */
export async function purgeExpiredPii(db: Db) {
  const days = retentionDays();
  const ledgerCutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sessionCutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

  const ledger = await db
    .delete(platformEventLedger)
    .where(lt(platformEventLedger.createdAt, ledgerCutoff))
    .returning({ id: platformEventLedger.id });

  const otps = await db
    .delete(authOtps)
    .where(lt(authOtps.expiresAt, new Date()))
    .returning({ id: authOtps.id });

  const revocations = await db
    .delete(authRevocations)
    .where(lt(authRevocations.revokedBefore, sessionCutoff))
    .returning({ mobileNumber: authRevocations.mobileNumber });

  const waSessions = await db
    .delete(waCheckoutSessions)
    .where(lt(waCheckoutSessions.expiresAt, new Date()))
    .returning({ mobileNumber: waCheckoutSessions.mobileNumber });

  const processedOutbox = await db
    .delete(outbox)
    .where(and(isNotNull(outbox.processedAt), lt(outbox.processedAt, ledgerCutoff)))
    .returning({ id: outbox.id });

  const rate = await purgeExpiredRateLimitBuckets(db);

  const adminRedacted = await redactOldAdminActionPayloads(db, ledgerCutoff);
  const ticketsRedacted = await redactResolvedTicketPii(db, ledgerCutoff);

  return {
    ok: true as const,
    retentionDays: days,
    deleted: {
      platformEventLedger: ledger.length,
      authOtps: otps.length,
      authRevocations: revocations.length,
      waCheckoutSessions: waSessions.length,
      outboxProcessed: processedOutbox.length,
      rateLimitBuckets: rate.deleted,
    },
    redacted: {
      adminActionLog: adminRedacted,
      supportTickets: ticketsRedacted,
    },
  };
}

/** Soft-redact mobiles in very old ledger rows instead of hard-delete (optional mode). */
export async function redactOldLedgerMobiles(db: Db) {
  const days = retentionDays();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const res = await db.execute(sql`
    UPDATE platform_event_ledger
    SET associated_mobile = NULL,
        raw_payload = CASE
          WHEN raw_payload IS NULL THEN NULL
          ELSE raw_payload - 'customerMobile' - 'mobile' - 'to'
        END
    WHERE created_at < ${cutoff}
      AND associated_mobile IS NOT NULL
  `);
  return {
    ok: true as const,
    retentionDays: days,
    updated: Number((res as { count?: number }).count ?? 0),
  };
}

/** Strip mobile-like fields from admin_action_log payloads older than the retention window. */
export async function redactOldAdminActionPayloads(db: Db, cutoff?: Date) {
  const days = retentionDays();
  const before = cutoff ?? new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: adminActionLog.id, payload: adminActionLog.payload })
    .from(adminActionLog)
    .where(and(lt(adminActionLog.createdAt, before), isNotNull(adminActionLog.payload)))
    .limit(500);

  let updated = 0;
  for (const row of rows) {
    if (!row.payload || typeof row.payload !== "object") continue;
    const next = scrubMobileFields(row.payload as Record<string, unknown>);
    if (!next.changed) continue;
    await db
      .update(adminActionLog)
      .set({ payload: next.value })
      .where(eq(adminActionLog.id, row.id));
    updated += 1;
  }
  return updated;
}

/**
 * After resolution + retention window, clear customer mobile on support tickets
 * (order FK + summary kept for dispute history).
 */
export async function redactResolvedTicketPii(db: Db, cutoff?: Date) {
  const days = retentionDays();
  const before = cutoff ?? new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const closed = await db
    .update(supportTickets)
    .set({ customerMobile: null })
    .where(
      and(
        isNotNull(supportTickets.customerMobile),
        isNotNull(supportTickets.resolvedAt),
        lt(supportTickets.resolvedAt, before),
        inArray(supportTickets.status, ["RESOLVED", "CLOSED"]),
      ),
    )
    .returning({ id: supportTickets.id });
  return closed.length;
}

function scrubMobileFields(payload: Record<string, unknown>): {
  changed: boolean;
  value: Record<string, unknown>;
} {
  const keys = ["customerMobile", "mobile", "mobileNumber", "to", "associatedMobile"];
  let changed = false;
  const value = { ...payload };
  for (const k of keys) {
    if (k in value && value[k] != null) {
      value[k] = null;
      changed = true;
    }
  }
  return { changed, value };
}
