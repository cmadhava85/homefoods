import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

type Journal = { entries?: Array<{ idx?: number; tag?: string }> };

function journalPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "drizzle", "meta", "_journal.json");
}

/** Number of migrations shipped with this package build (from drizzle journal). */
export function expectedMigrationCount(): number {
  const raw = readFileSync(journalPath(), "utf8");
  const journal = JSON.parse(raw) as Journal;
  return Array.isArray(journal.entries) ? journal.entries.length : 0;
}

/** Rows in drizzle.__drizzle_migrations (applied count). */
export async function appliedMigrationCount(db: Db): Promise<number> {
  try {
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM drizzle.__drizzle_migrations
    `)) as unknown as Array<{ n: number }>;
    const n = rows[0]?.n;
    return typeof n === "number" ? n : Number(n ?? 0);
  } catch {
    // Schema/migrations table missing → treat as zero applied.
    return 0;
  }
}

export async function assertSchemaCurrent(db: Db, opts?: { allowBehind?: boolean }) {
  const expected = expectedMigrationCount();
  const applied = await appliedMigrationCount(db);
  if (applied >= expected) {
    return { ok: true as const, expected, applied };
  }
  if (opts?.allowBehind || process.env.ALLOW_SCHEMA_BEHIND === "true") {
    return { ok: false as const, expected, applied, allowed: true as const };
  }
  return { ok: false as const, expected, applied, allowed: false as const };
}
