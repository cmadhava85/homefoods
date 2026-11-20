import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });
config();

import http from "node:http";
import { and, eq, lt } from "drizzle-orm";
import { createDb, orders } from "@localmeals/db";
import {
  LogEvent,
  createServiceLogger,
  startTelemetry,
} from "@localmeals/observability";
import { drainOutboxOnce } from "./drainOutbox.js";
import { recordConfirmingStuckOnce } from "./opsLedger.js";

await startTelemetry("localmeals-worker");

const log = createServiceLogger("localmeals-worker");
// Cloud SQL f1-micro: keep worker pool tiny to avoid CONNECT_TIMEOUT storms.
const db = createDb(process.env.DATABASE_URL, {
  max: Number(process.env.DB_POOL_MAX ?? 2),
});
const apiBase = process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
/** Orders stuck in CONFIRMING_PAYMENT longer than this are logged for ops alerts. */
const CONFIRMING_STUCK_MS = Number(process.env.CONFIRMING_STUCK_MS ?? 15 * 60 * 1000);

async function processOutbox() {
  await drainOutboxOnce(db, { apiBase, logger: log });
}

function internalHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.INTERNAL_JOB_TOKEN?.trim();
  if (token) headers["X-Internal-Token"] = token;
  return headers;
}

async function scanStuckConfirmingPayments() {
  const cutoff = new Date(Date.now() - CONFIRMING_STUCK_MS);
  const stuck = await db
    .select({
      id: orders.id,
      publicId: orders.publicId,
      updatedAt: orders.updatedAt,
      customerMobile: orders.customerMobile,
      cookId: orders.cookId,
    })
    .from(orders)
    .where(and(eq(orders.status, "CONFIRMING_PAYMENT"), lt(orders.updatedAt, cutoff)))
    .limit(50);
  for (const o of stuck) {
    log.warn(
      {
        event: LogEvent.PAYMENT_CONFIRMING_STUCK,
        orderId: o.id,
        publicId: o.publicId,
        updatedAt: o.updatedAt?.toISOString?.() ?? o.updatedAt,
        stuckMs: CONFIRMING_STUCK_MS,
      },
      "order stuck in CONFIRMING_PAYMENT",
    );
    await recordConfirmingStuckOnce(db, {
      orderId: o.id,
      publicId: o.publicId,
      customerMobile: o.customerMobile,
      cookId: o.cookId,
      stuckMs: CONFIRMING_STUCK_MS,
    }).catch(() => undefined);
  }
  return stuck.length;
}

async function maybeRunScheduled() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  if (process.env.ENABLE_AUTO_CUTOFF === "true" && minute % 5 === 0) {
    await fetch(`${apiBase}/internal/cutoffs/LUNCH`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({}),
    });
  }
  if (process.env.ENABLE_AUTO_EOD === "true" && hour === 18 && minute === 0) {
    await fetch(`${apiBase}/internal/settlements/eod`, {
      method: "POST",
      headers: internalHeaders(),
      body: "{}",
    });
  }
  // Daily PII / ephemeral state purge (03:00 local). Override with ENABLE_AUTO_RETENTION=false.
  if (process.env.ENABLE_AUTO_RETENTION !== "false" && hour === 3 && minute === 0) {
    await fetch(`${apiBase}/internal/ops/retention`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ mode: "purge" }),
    });
  }
}

// Cloud Run requires a listening port for health checks.
const healthPort = Number(process.env.PORT ?? 8080);
http
  .createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(healthPort, "0.0.0.0", () => {
    log.info({ healthPort }, "worker health listening");
  });

const pollMs = Math.max(2000, Number(process.env.OUTBOX_POLL_MS ?? 5000));
log.info({ event: LogEvent.WORKER_STARTED, pollMs }, "worker started — polling outbox");
let lastStuckScan = 0;
setInterval(() => {
  processOutbox().catch((err) => log.error({ err, event: LogEvent.OUTBOX_FAILED }, "outbox poll failed"));
  maybeRunScheduled().catch((err) => log.error({ err }, "scheduled jobs failed"));
  const now = Date.now();
  if (now - lastStuckScan > 60_000) {
    lastStuckScan = now;
    scanStuckConfirmingPayments().catch((err) =>
      log.error({ err }, "stuck payment scan failed"),
    );
  }
}, pollMs);

processOutbox().catch((err) => log.error({ err }, "initial outbox poll failed"));
