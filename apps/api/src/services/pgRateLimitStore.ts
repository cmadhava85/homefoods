import { sql } from "drizzle-orm";
import type { Db } from "@localmeals/db";

type IncrCb = (
  error: Error | null,
  result?: { current: number; ttl: number },
) => void;

type StoreOptions = Record<string, unknown>;

/**
 * Postgres-backed store for `@fastify/rate-limit` so limits hold across Cloud Run instances.
 * Constructor signature matches FastifyRateLimitStoreCtor.
 */
export function createPgRateLimitStore(db: Db) {
  return class PgRateLimitStore {
    options: StoreOptions;

    constructor(options: StoreOptions = {}) {
      this.options = options;
    }

    incr(key: string, callback: IncrCb, timeWindow: number, _max: number): void {
      void (async () => {
        const now = Date.now();
        // postgres.js rejects Date params in drizzle sql`` — bind ISO timestamptz string.
        const resetAtIso = new Date(now + timeWindow).toISOString();
        const result = await db.execute(sql`
          INSERT INTO rate_limit_buckets (bucket_key, hits, reset_at)
          VALUES (${key}, 1, ${resetAtIso}::timestamptz)
          ON CONFLICT (bucket_key) DO UPDATE SET
            hits = CASE
              WHEN rate_limit_buckets.reset_at <= NOW() THEN 1
              ELSE rate_limit_buckets.hits + 1
            END,
            reset_at = CASE
              WHEN rate_limit_buckets.reset_at <= NOW() THEN EXCLUDED.reset_at
              ELSE rate_limit_buckets.reset_at
            END
          RETURNING hits, reset_at
        `);
        const rows = result as unknown as Array<{ hits: number; reset_at: Date | string }>;
        const row = Array.isArray(rows) ? rows[0] : undefined;
        if (!row) {
          callback(null, { current: 1, ttl: timeWindow });
          return;
        }
        const resetMs =
          row.reset_at instanceof Date
            ? row.reset_at.getTime()
            : new Date(row.reset_at).getTime();
        const ttl = Math.max(0, resetMs - Date.now());
        callback(null, { current: Number(row.hits) || 1, ttl });
      })().catch((err: Error) => callback(err));
    }

    child(routeOptions: StoreOptions): PgRateLimitStore {
      return new PgRateLimitStore({ ...this.options, ...routeOptions });
    }
  };
}

/** Best-effort cleanup of expired buckets (called from retention purge). */
export async function purgeExpiredRateLimitBuckets(db: Db) {
  const res = await db.execute(sql`
    DELETE FROM rate_limit_buckets WHERE reset_at < NOW()
  `);
  const deleted = Number((res as { count?: number }).count ?? 0);
  return { deleted };
}
