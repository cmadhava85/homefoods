import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });
config();

import http from "node:http";
import { and, eq, lt } from "drizzle-orm";
import { closeDb, createDb, orders } from "@localmeals/db";
import {
  LogEvent,
  createServiceLogger,
  installProcessLifecycle,
  maskMobile,
  startTelemetry,
} from "@localmeals/observability";
import { drainOutboxOnce } from "./drainOutbox.js";
import { drainUntilEmpty } from "./drainUntilEmpty.js";
import { recordConfirmingStuckOnce } from "./opsLedger.js";

const flushTelemetry = await startTelemetry("localmeals-worker");

const log = createServiceLogger("localmeals-worker");
// Cloud SQL f1-micro: keep worker pool tiny to avoid CONNECT_TIMEOUT storms.
const db = createDb(process.env.DATABASE_URL, {
  max: Number(process.env.DB_POOL_MAX ?? 2),
});
const apiBase = process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
/** Orders stuck in CONFIRMING_PAYMENT longer than this are logged for ops alerts. */
const CONFIRMING_STUCK_MS = Number(process.env.CONFIRMING_STUCK_MS ?? 15 * 60 * 1000);

let outboxInFlight = false;
async function processOutbox() {
  // Never overlap drains in this process (a slow batch must not race the next tick).
  if (outboxInFlight) return;
  outboxInFlight = true;
  try {
    await drainOutboxOnce(db, { apiBase, logger: log });
  } finally {
    outboxInFlight = false;
  }
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
        customerMobile: maskMobile(o.customerMobile),
        cookId: o.cookId,
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

/** The poll runs every few seconds — fire each scheduled job at most once per wall-clock slot. */
const firedSlots = new Map<string, string>();
function firstInSlot(job: string, slot: string): boolean {
  if (firedSlots.get(job) === slot) return false;
  firedSlots.set(job, slot);
  return true;
}

async function maybeRunScheduled() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const minuteSlot = `${now.toDateString()} ${hour}:${minute}`;
  // Cloud Scheduler owns expiry in prod (ENABLE_AUTO_EXPIRE=false there); local dev keeps it on.
  if (
    process.env.ENABLE_AUTO_EXPIRE !== "false" &&
    minute % 5 === 0 &&
    firstInSlot("expire", minuteSlot)
  ) {
    await fetch(`${apiBase}/internal/ops/expire-unpaid`, {
      method: "POST",
      headers: internalHeaders(),
      body: "{}",
    }).catch(() => undefined);
  }
  if (
    process.env.ENABLE_AUTO_CUTOFF === "true" &&
    minute % 5 === 0 &&
    firstInSlot("cutoff", minuteSlot)
  ) {
    for (const meal of ["BREAKFAST", "LUNCH", "DINNER"] as const) {
      await fetch(`${apiBase}/internal/cutoffs/${meal}`, {
        method: "POST",
        headers: internalHeaders(),
        body: JSON.stringify({}),
      });
    }
  }
  if (
    process.env.ENABLE_AUTO_EOD === "true" &&
    hour === 21 &&
    minute === 0 &&
    firstInSlot("eod", minuteSlot)
  ) {
    await fetch(`${apiBase}/internal/settlements/eod`, {
      method: "POST",
      headers: internalHeaders(),
      body: "{}",
    });
  }
  // Daily PII / ephemeral state purge (03:00 local). Override with ENABLE_AUTO_RETENTION=false.
  if (
    process.env.ENABLE_AUTO_RETENTION !== "false" &&
    hour === 3 &&
    minute === 0 &&
    firstInSlot("retention", minuteSlot)
  ) {
    await fetch(`${apiBase}/internal/ops/retention`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ mode: "purge" }),
    });
  }
}

/**
 * WORKER_MODE=poll (default, local dev): poll the outbox every OUTBOX_POLL_MS.
 * WORKER_MODE=push (Cloud Run, min instances 0): no timers. POST /drain is called by the
 * Pub/Sub "outbox wake" push subscription (API publishes after enqueueing) and by a 1-minute
 * Cloud Scheduler fallback. Cloud Run IAM (run.invoker + OIDC) authenticates both callers.
 */
const pushMode = process.env.WORKER_MODE === "push";
let lastStuckScan = 0;

function maybeScanStuck() {
  const now = Date.now();
  if (now - lastStuckScan <= 60_000) return Promise.resolve();
  lastStuckScan = now;
  return scanStuckConfirmingPayments()
    .then(() => undefined)
    .catch((err) => log.error({ err }, "stuck payment scan failed"));
}

let drainChain: Promise<unknown> = Promise.resolve();
/** Serialise wakes in this instance: a wake arriving mid-drain runs one more pass after it. */
function runDrainCycle() {
  const cycle = drainChain.then(async () => {
    outboxInFlight = true;
    try {
      const result = await drainUntilEmpty(db, { apiBase, logger: log });
      await maybeRunScheduled().catch((err) => log.error({ err }, "scheduled jobs failed"));
      await maybeScanStuck();
      return result;
    } finally {
      outboxInFlight = false;
    }
  });
  drainChain = cycle.catch(() => undefined);
  return cycle;
}

// Cloud Run requires a listening port; it also carries POST /drain in push mode.
const healthPort = Number(process.env.PORT ?? 8080);
const healthServer = http
  .createServer((req, res) => {
    if (pushMode && req.method === "POST" && req.url?.split("?")[0] === "/drain") {
      req.resume();
      runDrainCycle()
        .then((r) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(r));
        })
        .catch((err) => {
          log.error({ err, event: LogEvent.OUTBOX_FAILED }, "drain failed");
          // 5xx → Pub/Sub retries with backoff.
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("drain failed");
        });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(healthPort, "0.0.0.0", () => {
    log.info({ healthPort, mode: pushMode ? "push" : "poll" }, "worker health listening");
  });

let poller: ReturnType<typeof setInterval> | undefined;
if (pushMode) {
  log.info({ event: LogEvent.WORKER_STARTED, mode: "push" }, "worker started — waiting for /drain");
} else {
  const pollMs = Math.max(2000, Number(process.env.OUTBOX_POLL_MS ?? 5000));
  log.info({ event: LogEvent.WORKER_STARTED, pollMs }, "worker started — polling outbox");
  poller = setInterval(() => {
    processOutbox().catch((err) => log.error({ err, event: LogEvent.OUTBOX_FAILED }, "outbox poll failed"));
    maybeRunScheduled().catch((err) => log.error({ err }, "scheduled jobs failed"));
    void maybeScanStuck();
  }, pollMs);
  processOutbox().catch((err) => log.error({ err }, "initial outbox poll failed"));
}

async function waitForOutboxIdle(maxMs: number) {
  const until = Date.now() + maxMs;
  while (outboxInFlight && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

installProcessLifecycle({
  service: "localmeals-worker",
  logger: log,
  steps: [
    { name: "poller", run: () => poller && clearInterval(poller) },
    // Let the current batch finish; anything unfinished is re-claimed after its lease expires.
    { name: "outbox", run: () => waitForOutboxIdle(6000) },
    { name: "health", run: () => new Promise<void>((r) => healthServer.close(() => r())) },
    { name: "db", run: () => closeDb(db) },
    { name: "telemetry", run: flushTelemetry },
  ],
});
