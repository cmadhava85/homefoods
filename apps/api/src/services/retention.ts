import { and, isNotNull, lt, sql } from "drizzle-orm";
import {
  authOtps,
  authRevocations,
  outbox,
  platformEventLedger,
  waCheckoutSessions,
  type Db,
} from "@localmeals/db";
import { purgeExpiredRateLimitBuckets } from "./pgRateLimitStore.js";

function retentionDays() {
  const n = Number(process.env.PII_RETENTION_DAYS ?? 90);
  return Number.isFinite(n) && n >= 7 ? Math.floor(n) : 90;
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
