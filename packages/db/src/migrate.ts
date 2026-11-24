import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPostgresClient } from "./client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production (refusing localhost default)");
  }
  const url = process.env.DATABASE_URL ?? "postgres://localmeals:localmeals@localhost:5432/localmeals";
  const sql = createPostgresClient(url, { max: 1 });
  const db = drizzle(sql);
  const migrationsFolder = path.join(__dirname, "..", "drizzle");
  console.log("Migrating from", migrationsFolder);
  await migrate(db, { migrationsFolder });
  await sql.end();
  console.log("Migrations complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
