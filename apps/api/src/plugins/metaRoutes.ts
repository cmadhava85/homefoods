import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import {
  appliedMigrationCount,
  expectedMigrationCount,
  type Db,
} from "@localmeals/db";
import { serviceDateISO } from "@localmeals/domain";

export async function metaRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;

  /** Cheap liveness — always 200 when the process is up. */
  app.get("/health", async () => ({ ok: true }));

  /**
   * Readiness: DB reachable + migrations current + outbox backlog snapshot.
   * Cloud Run startup / uptime should target this (not /health).
   */
  app.get("/ready", async (_req, reply) => {
    let dbOk = false;
    let schemaOk = false;
    let expected = 0;
    let applied = 0;
    let pending = 0;
    let oldestPendingAgeSec: number | null = null;

    try {
      expected = expectedMigrationCount();
      await Promise.race([
        db.execute(sql`select 1`),
        new Promise((_, rej) => setTimeout(() => rej(new Error("db_timeout")), 2000)),
      ]);
      dbOk = true;
      applied = await appliedMigrationCount(db);
      schemaOk = applied >= expected;
      const backlog = (await db.execute(sql`
        SELECT
          COUNT(*) FILTER (WHERE processed_at IS NULL)::int AS pending,
          EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE processed_at IS NULL)))::int AS oldest_age
        FROM outbox
      `)) as unknown as Array<{ pending: number; oldest_age: number | null }>;
      pending = Number(backlog[0]?.pending ?? 0);
      oldestPendingAgeSec =
        backlog[0]?.oldest_age == null ? null : Number(backlog[0].oldest_age);
    } catch {
      dbOk = false;
      schemaOk = false;
    }

    const ok = dbOk && schemaOk;
    const body = {
      ok,
      db: dbOk,
      schema: { ok: schemaOk, expected, applied },
      outbox: { pending, oldestPendingAgeSec },
    };
    return reply.code(ok ? 200 : 503).send(body);
  });

  app.get("/meta/today", async () => ({ serviceDate: serviceDateISO() }));

  app.get("/meta/features", async () => {
    const { getFeatureFlags } = await import("../services/featureFlags.js");
    try {
      return { flags: await getFeatureFlags(db) };
    } catch {
      const { defaultFeatureFlags } = await import("@localmeals/domain");
      return { flags: defaultFeatureFlags() };
    }
  });
}
