import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

/** A pooled client or an open `db.transaction` handle — for helpers that run in either. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type CreateDbOptions = {
  /** Max connections in the pool (worker should stay small on Cloud SQL). */
  max?: number;
};

const clients = new WeakMap<object, ReturnType<typeof postgres>>();

/**
 * Cloud Run Secret Manager uses:
 *   postgres://user:pass@/db?host=/cloudsql/PROJECT:REGION:INSTANCE
 * postgres.js cannot parse an empty URL host — convert to options.
 */
export function createPostgresClient(
  connectionString: string,
  options: { max?: number } = {},
) {
  const max = options.max ?? 10;
  // Serverless / Cloud Run: recycle sockets before Cloud SQL closes them.
  const shared = {
    max,
    idle_timeout: 20,
    connect_timeout: 30,
    max_lifetime: 60 * 20,
    prepare: false as const,
  };

  const cloudSql = connectionString.match(
    /^postgres(?:ql)?:\/\/([^:/?#]+):([^@]+)@\/([^?]+)\?host=([^&]+)/i,
  );
  if (cloudSql) {
    const [, user, password, database, host] = cloudSql;
    return postgres({
      user: decodeURIComponent(user),
      password: decodeURIComponent(password),
      database: decodeURIComponent(database),
      host: decodeURIComponent(host),
      ...shared,
    });
  }
  return postgres(connectionString, shared);
}

export function createDb(
  connectionString = process.env.DATABASE_URL,
  options: CreateDbOptions = {},
) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const sql = createPostgresClient(connectionString, {
    max: options.max ?? Number(process.env.DB_POOL_MAX ?? 10),
  });
  const db = drizzle(sql, { schema });
  clients.set(db, sql);
  return db;
}

export async function closeDb(db: Db) {
  const sql = clients.get(db);
  if (sql) await sql.end({ timeout: 1 });
}
