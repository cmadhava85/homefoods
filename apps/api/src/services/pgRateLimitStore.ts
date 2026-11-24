import { sql } from "drizzle-orm";
import type { Db } from "@localmeals/db";

type IncrCb = (
  error: Error | null,
  result?: { current: number; ttl: number },
) => void;

type StoreOptions = {
  max?: number;
  timeWindow?: number | string;
  /** Optional label when Fastify passes route metadata. */
  routeInfo?: { method?: string; url?: string };
};

/**
 * Postgres-backed store for `@fastify/rate-limit` so limits hold across Cloud Run instances.
 * Constructor signature matches FastifyRateLimitStoreCtor.
 *
 * Bucket keys include max + timeWindow (+ route when present) so OTP’s 15‑minute
 * window does not block unrelated routes that share the same client IP.
 */
export function createPgRateLimitStore(db: Db) {
  return class PgRateLimitStore {
    options: StoreOptions;

    // The plugin passes its own option bag (and route options in child()); we only read StoreOptions keys.
    constructor(options: object = {}) {
      this.options = options as StoreOptions;
    }

    private bucketKey(clientKey: string): string {
      const max = this.options.max ?? "g";
      const window = this.options.timeWindow ?? "default";
      const route = this.options.routeInfo
        ? `${this.options.routeInfo.method ?? ""}:${this.options.routeInfo.url ?? ""}`
        : "";
      const raw = route ? `${route}|${max}|${window}|${clientKey}` : `${max}|${window}|${clientKey}`;
      return raw.slice(0, 255);
    }

    incr(key: string, callback: IncrCb, timeWindow: number, _max: number): void {
      void (async () => {
        const now = Date.now();
        // postgres.js rejects Date params in drizzle sql`` — bind ISO timestamptz string.
        const resetAtIso = new Date(now + timeWindow).toISOString();
        const bucketKey = this.bucketKey(key);
        const result = await db.execute(sql`
          INSERT INTO rate_limit_buckets (bucket_key, hits, reset_at)
          VALUES (${bucketKey}, 1, ${resetAtIso}::timestamptz)
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

    child(routeOptions: object): PgRateLimitStore {
      return new PgRateLimitStore({ ...this.options, ...(routeOptions as StoreOptions) });
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

/**
 * Global limit in memory, route-specific limits in Postgres.
 *
 * The global per-IP cap (hundreds/min) is a coarse flood guard, so per-instance counting is fine
 * (effective cap = max × instances). Routes that set their own `config.rateLimit` (OTP, login, orders,
 * uploads, deletion) are created via `child()` and stay Postgres-backed so they hold across instances.
 * Without this, every request — including cached menu reads — cost one DB upsert.
 */
export function createHybridRateLimitStore(db: Db, maxKeys = 10_000) {
  const PgStore = createPgRateLimitStore(db);
  return class HybridRateLimitStore {
    private readonly options: object;
    private readonly buckets = new Map<string, { hits: number; resetAt: number }>();

    constructor(options: object = {}) {
      this.options = options;
    }

    incr(key: string, callback: IncrCb, timeWindow: number): void {
      const now = Date.now();
      let b = this.buckets.get(key);
      if (!b || b.resetAt <= now) {
        if (!b && this.buckets.size >= maxKeys) {
          // Drop the oldest entry (Map keeps insertion order).
          const oldest = this.buckets.keys().next().value;
          if (oldest !== undefined) this.buckets.delete(oldest);
        }
        b = { hits: 0, resetAt: now + timeWindow };
        this.buckets.delete(key);
        this.buckets.set(key, b);
      }
      b.hits += 1;
      callback(null, { current: b.hits, ttl: Math.max(0, b.resetAt - now) });
    }

    child(routeOptions: object) {
      return new PgStore({ ...this.options, ...routeOptions });
    }
  };
}
