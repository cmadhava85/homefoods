import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
config({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env") });
config();

import { and, eq, lt } from "drizzle-orm";
import { createDb, orders, outbox } from "@localmeals/db";
import { getWhatsAppProvider, isNonRetryableWhatsAppError } from "@localmeals/adapters";
import {
  formatOrderPaidCookWa,
  formatOrderPaidCustomerWa,
} from "@localmeals/domain";
import {
  LogEvent,
  createServiceLogger,
  readCorr,
  startTelemetry,
} from "@localmeals/observability";

await startTelemetry("localmeals-worker");

const log = createServiceLogger("localmeals-worker");
// Cloud SQL f1-micro: keep worker pool tiny to avoid CONNECT_TIMEOUT storms.
const db = createDb(process.env.DATABASE_URL, {
  max: Number(process.env.DB_POOL_MAX ?? 2),
});
const apiBase = process.env.API_INTERNAL_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
/** Orders stuck in CONFIRMING_PAYMENT longer than this are logged for ops alerts. */
const CONFIRMING_STUCK_MS = Number(process.env.CONFIRMING_STUCK_MS ?? 15 * 60 * 1000);
/** After this many failures, park the outbox row (stop infinite retry spam). */
const OUTBOX_MAX_ATTEMPTS = Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 8);

function str(v: unknown) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function rowLog(row: { id: number; eventName: string }, payload: Record<string, unknown>) {
  const corr = readCorr(payload);
  return log.child({
    outboxId: row.id,
    eventName: row.eventName,
    traceId: corr.traceId,
    requestId: corr.requestId,
    publicId: corr.publicId,
    checkoutId: corr.checkoutId,
  });
}

async function sendWa(
  logger: ReturnType<typeof rowLog>,
  wa: ReturnType<typeof getWhatsAppProvider>,
  message: Parameters<ReturnType<typeof getWhatsAppProvider>["send"]>[0],
) {
  try {
    await wa.send(message);
  } catch (err) {
    logger.error(
      { err, event: LogEvent.WA_SEND_FAILED, to: message.to },
      "whatsapp send failed",
    );
    throw err;
  }
}

async function whatsappOutboundAllowed(): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/meta/features`);
    if (!res.ok) return true;
    const json = (await res.json()) as { flags?: Record<string, boolean> };
    if (json.flags && typeof json.flags.whatsapp_outbound_enabled === "boolean") {
      return json.flags.whatsapp_outbound_enabled;
    }
  } catch {
    /* fail open so jobs aren't stuck if API is down briefly */
  }
  return true;
}

async function processOutbox() {
  const rows = await db.query.outbox.findMany({
    where: (t, { isNull: n }) => n(t.processedAt),
    limit: 20,
  });
  const wa = getWhatsAppProvider();
  const waOut = await whatsappOutboundAllowed();
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const logger = rowLog(row, payload);
    const attempts = row.attempts ?? 0;
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      logger.warn(
        {
          event: LogEvent.OUTBOX_SKIPPED,
          reason: "max_attempts",
          attempts,
          lastError: row.lastError,
        },
        "outbox parked after max attempts",
      );
      await db
        .update(outbox)
        .set({
          processedAt: new Date(),
          lastError: row.lastError ?? `max_attempts_${OUTBOX_MAX_ATTEMPTS}`,
        })
        .where(eq(outbox.id, row.id));
      continue;
    }
    try {
      if (!waOut) {
        // Still mark processed so queue doesn't back up; ops can re-enable and rely on future events.
        logger.warn({ event: LogEvent.OUTBOX_SKIPPED, reason: "whatsapp_outbound_disabled" }, "outbox skipped");
        await db
          .update(outbox)
          .set({ processedAt: new Date(), lastError: "whatsapp_outbound_disabled" })
          .where(eq(outbox.id, row.id));
        continue;
      }
      if (row.eventName === "OrderCreated") {
        const customerMobile = str(payload.customerMobile);
        const kitchen = str(payload.kitchenName) || "kitchen";
        const payUrl = str(payload.paymentUrl);
        const pid = str(payload.publicId);
        const checkoutId = str(payload.checkoutId);
        const lines = Array.isArray(payload.lines) ? payload.lines : null;
        const amountPaise = Number(payload.amountPaise ?? 0);
        const amountLabel = amountPaise > 0 ? `₹${(amountPaise / 100).toFixed(0)}` : null;
        const childPays = Boolean(payload.childPays);
        const payerMobile = str(payload.payerMobile);

        let body: string;
        if (childPays) {
          body = [
            `🧾 Week order placed · ${kitchen}`,
            checkoutId || pid,
            amountLabel ? `Total ${amountLabel}` : null,
            payerMobile
              ? `Waiting for family ${payerMobile} to pay on UPI.`
              : "Waiting for family to pay on UPI.",
            "",
            "You’ll get confirmation after they pay.",
          ]
            .filter(Boolean)
            .join("\n");
        } else if (lines && lines.length) {
          const dayLines = lines
            .map((l) => {
              const row = l as Record<string, unknown>;
              return `· ${str(row.serviceDate)} · ${row.qty ?? 1}× ${str(row.itemName) || "plate"}`;
            })
            .join("\n");
          body = [
            `🧾 Week order placed · ${kitchen}`,
            checkoutId || pid,
            dayLines,
            amountLabel ? `Total ${amountLabel}` : null,
            payUrl ? `Pay: ${payUrl}` : "Reply Pay to open UPI.",
            "",
            "You’ll get a confirmation for each day after payment.",
          ]
            .filter(Boolean)
            .join("\n");
        } else {
          body = [
            `🧾 Order placed · ${kitchen}`,
            `${pid} · ${payload.qty ?? 1}× ${str(payload.itemName) || "plate"}`,
            payload.serviceDate ? `For ${str(payload.serviceDate)}` : null,
            amountLabel ? `Amount ${amountLabel}` : null,
            payUrl ? `Pay: ${payUrl}` : "Reply Pay to open UPI.",
            "",
            "You’ll get updates for this order until delivery.",
          ]
            .filter(Boolean)
            .join("\n");
        }

        if (customerMobile.length > 5) {
          await sendWa(logger, wa, {
            to: customerMobile,
            body,
            buttons: childPays
              ? ["Orders", "Menu"].slice(0, 3)
              : pid
                ? [`Pay ${pid}`, "Orders", "Menu"].slice(0, 3)
                : checkoutId
                  ? [`Pay ${checkoutId}`, "Orders", "Menu"].slice(0, 3)
                  : ["Pay", "Orders", "Menu"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "customer" }, "OrderCreated notified");
        } else {
          logger.warn({ event: LogEvent.OUTBOX_SKIPPED, reason: "missing_customer_mobile" }, "OrderCreated skip");
        }
      }

      if (row.eventName === "ChildPaysRequested") {
        const payerMobile = str(payload.payerMobile);
        const seniorMobile = str(payload.seniorMobile);
        const kitchen = str(payload.kitchenName) || "kitchen";
        const payUrl = str(payload.paymentUrl);
        const checkoutId = str(payload.checkoutId);
        const amountPaise = Number(payload.amountPaise ?? 0);
        const amountLabel = amountPaise > 0 ? `₹${(amountPaise / 100).toFixed(0)}` : null;
        if (payerMobile.length > 5) {
          await sendWa(logger, wa, {
            to: payerMobile,
            body: [
              `👨‍👩‍👧 Family pay request · ${kitchen}`,
              seniorMobile ? `For ${seniorMobile}` : null,
              checkoutId,
              amountLabel ? `Amount ${amountLabel}` : null,
              payUrl ? `Pay: ${payUrl}` : "Open My orders → Pay now.",
              "",
              "This settles their home meal on UPI.",
            ]
              .filter(Boolean)
              .join("\n"),
            buttons: checkoutId
              ? [`Pay ${checkoutId}`, "Orders", "Menu"].slice(0, 3)
              : ["Pay", "Orders", "Menu"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "payer" }, "ChildPaysRequested notified");
        }
      }

      if (row.eventName === "OrderPaid") {
        const cookMobile = str(payload.cookMobile);
        const customerMobile = str(payload.customerMobile);
        const cookBody = formatOrderPaidCookWa(payload);
        const customerBody = formatOrderPaidCustomerWa(payload);

        if (cookMobile.length > 5) {
          await sendWa(logger, wa, {
            to: cookMobile,
            body: cookBody,
            buttons: ["Status", "Cooking", "Packed"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "cook" }, "OrderPaid cook notified");
        } else {
          logger.warn({ event: LogEvent.OUTBOX_SKIPPED, reason: "missing_cook_mobile" }, "OrderPaid skip cook");
        }

        // Customer confirmation for every paid order line (date + week day N of M)
        if (customerMobile.length > 5) {
          await sendWa(logger, wa, {
            to: customerMobile,
            body: customerBody,
            buttons: ["Orders", "Menu"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "customer" }, "OrderPaid customer notified");
        }
      }

      if (row.eventName === "OrderCancelled") {
        const customerMobile = str(payload.customerMobile);
        if (customerMobile.length > 5) {
          const body = [
            `❎ Order cancelled · ${str(payload.publicId)}`,
            payload.itemName
              ? `${payload.qty ?? 1}× ${str(payload.itemName)}${payload.serviceDate ? ` · ${str(payload.serviceDate)}` : ""}`
              : null,
            str(payload.kitchenName) ? `Kitchen: ${str(payload.kitchenName)}` : null,
            payload.wasPaid ? "If you paid, refund will be processed." : "No payment was taken.",
          ]
            .filter(Boolean)
            .join("\n");
          await sendWa(logger, wa, {
            to: customerMobile,
            body,
            buttons: ["Orders", "Menu"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "customer" }, "OrderCancelled notified");
        }
      }

      if (row.eventName === "CancelRequested") {
        const cookMobile = str(payload.cookMobile);
        const pid = str(payload.publicId);
        const body = [
          "❎ Cancel request (after cut-off)",
          `${pid} · ${payload.qty ?? 1}× ${str(payload.itemName) || "plate"}`,
          `Customer: ${str(payload.customerMobile)}`,
          payload.serviceDate ? `Date: ${str(payload.serviceDate)}` : null,
          "",
          "Accept → full refund. Decline → keep cooking.",
        ]
          .filter(Boolean)
          .join("\n");
        if (cookMobile.length > 5) {
          await sendWa(logger, wa, {
            to: cookMobile,
            body,
            buttons: pid
              ? [`Accept ${pid}`, `Decline ${pid}`, "Status"]
              : ["Status"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "cook" }, "CancelRequested notified");
        }
      }

      if (row.eventName === "CancelDeclined") {
        const customerMobile = str(payload.customerMobile);
        if (customerMobile.length > 5) {
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [
              `Kitchen kept your order · ${str(payload.publicId)}`,
              str(payload.reason) || "Food is being prepared.",
              "Open My orders for status, or Report a concern if needed.",
            ].join("\n"),
            buttons: ["Orders", "Help"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "customer" }, "CancelDeclined notified");
        }
      }

      if (row.eventName === "OrderStatusChanged") {
        // High-value customer pings only (skip COOKING/PACKED to cut WA cost)
        const to = str(payload.toStatus);
        const customerMobile = str(payload.customerMobile);
        const publicId = str(payload.publicId);
        const kitchen = str(payload.kitchenName) || "kitchen";
        const itemLine = `${payload.qty ?? 1}× ${str(payload.itemName) || "plate"} from ${kitchen}`;

        if (customerMobile.length > 5 && to === "DISPATCHED") {
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [`🛵 On the way · ${publicId}`, itemLine].join("\n"),
            buttons: ["Orders"],
          });
        }
        if (customerMobile.length > 5 && to === "DELIVERED") {
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [
              `✅ Delivered · ${publicId}. Enjoy your lunch!`,
              "",
              "How was it? Open My orders and leave a quick star rating — it helps neighbours choose a kitchen.",
            ].join("\n"),
            buttons: ["Orders", "Menu"],
          });
        }
        if (customerMobile.length > 5 && to === "CANCEL_REQUESTED") {
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [
              `Asked kitchen to cancel · ${publicId}`,
              "Waiting for the cook to Accept (refund) or Decline (keep order).",
            ].join("\n"),
            buttons: ["Orders"],
          });
        }
        if (to === "COOKING" || to === "PACKED") {
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, toStatus: to }, "OrderStatusChanged");
        }
      }

      if (row.eventName === "FamilyLinkRequested") {
        const payerMobile = str(payload.payerMobile);
        const seniorMobile = str(payload.seniorMobile);
        if (payerMobile.length > 5) {
          await sendWa(logger, wa, {
            to: payerMobile,
            body: [
              "👨‍👩‍👧 Family pay invite",
              seniorMobile
                ? `${seniorMobile} wants you to settle their LocalMeals UPI.`
                : "A family member wants you to settle their LocalMeals UPI.",
              "",
              "Open the app → Family → Accept. Then you can pay when they order.",
            ].join("\n"),
            buttons: ["Orders", "Menu"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "payer" }, "FamilyLinkRequested notified");
        }
      }

      if (row.eventName === "LateOrderRequested") {
        const cookMobile = str(payload.cookMobile);
        const pid = str(payload.publicId);
        const body = [
          "⏰ Late lunch request",
          `${pid} · ${payload.qty ?? 1}× ${str(payload.itemName) || "plate"}`,
          `Customer: ${str(payload.customerMobile)}`,
          `📍 ${str(payload.deliveryTargetAddress) || "address TBD"}`,
          "",
          "Accept → customer pays. Decline → no charge.",
        ].join("\n");
        if (cookMobile.length > 5) {
          await sendWa(logger, wa, {
            to: cookMobile,
            body,
            buttons: pid
              ? [`Accept ${pid}`, `Decline ${pid}`, "Late requests"]
              : ["Late requests", "Status"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "cook" }, "LateOrderRequested notified");
        }
      }

      if (row.eventName === "LateOrderApproved") {
        const customerMobile = str(payload.customerMobile);
        const payUrl = str(payload.paymentUrl);
        const pid = str(payload.publicId);
        const body = [
          `✅ Late lunch accepted by ${str(payload.kitchenName) || "kitchen"}`,
          `${pid} · ${payload.qty ?? 1}× ${str(payload.itemName) || "plate"}`,
          payUrl ? `Pay link: ${payUrl}` : "Tap Pay below.",
          "",
          `Reply Pay ${pid} anytime for the link again.`,
        ].join("\n");
        if (customerMobile.length > 5) {
          await sendWa(logger, wa, {
            to: customerMobile,
            body,
            buttons: pid ? [`Pay ${pid}`, "Menu"] : ["Pay", "Menu"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "customer" }, "LateOrderApproved notified");
        }
      }

      if (row.eventName === "LateOrderDeclined") {
        const customerMobile = str(payload.customerMobile);
        const body = [
          `❌ Late request ${str(payload.publicId)} declined`,
          str(payload.reason) || "Kitchen could not take a late order.",
          "No payment was taken. Try Menu for another day or kitchen.",
        ].join("\n");
        if (customerMobile.length > 5) {
          await sendWa(logger, wa, { to: customerMobile, body, buttons: ["Menu"] });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "customer" }, "LateOrderDeclined notified");
        }
      }

      if (row.eventName === "CutoffReached") {
        // API already sends the manifest WA; worker logs for ops visibility.
        logger.info(
          {
            event: LogEvent.CUTOFF_REACHED,
            cookId: payload.cookId,
            headcount: payload.headcount,
            hasRoute: Boolean(payload.routeMapsUrl),
          },
          "CutoffReached",
        );
      }

      if (row.eventName === "KitchenMenuPosted") {
        const cookId = str(payload.cookId);
        const kitchenName = str(payload.kitchenName) || "Kitchen";
        const cookSlug = str(payload.cookSlug);
        const itemName = str(payload.itemName) || "New plate";
        const pricePaise = Number(payload.pricePaise ?? 0);
        const when = payload.weekly
          ? "weekly plate"
          : payload.serviceDate
            ? `for ${str(payload.serviceDate)}`
            : "today";
        const followers = cookId
          ? await db.query.kitchenFollowers.findMany({
              where: (t, { eq: e }) => e(t.cookId, cookId),
            })
          : [];
        const body = [
          `📣 ${kitchenName} posted a new plate`,
          `${itemName}${pricePaise ? ` — ₹${(pricePaise / 100).toFixed(0)}` : ""} · ${when}`,
          "",
          cookSlug
            ? `Menu ${cookSlug} · Order ${cookSlug} · Week ${cookSlug} all`
            : "Reply Menu to browse.",
        ].join("\n");
        for (const f of followers) {
          await sendWa(logger, wa, {
            to: f.customerMobile,
            body,
            buttons: cookSlug
              ? [`Menu ${cookSlug}`, `Week ${cookSlug} all`, "Orders"].slice(0, 3)
              : ["Menu", "Orders"],
          });
        }
        logger.info(
          {
            event: LogEvent.OUTBOX_PROCESSED,
            channel: "whatsapp",
            followerCount: followers.length,
            cookSlug,
            itemName,
          },
          "KitchenMenuPosted notified",
        );
      }

      if (row.eventName === "OrderPaymentFailed") {
        const customerMobile = str(payload.customerMobile);
        if (customerMobile.length > 5) {
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [
              `⚠️ Payment failed · ${str(payload.publicId)}`,
              "No money was taken. Reply Pay to try again, or Orders.",
            ].join("\n"),
            buttons: ["Pay", "Orders"],
          });
        }
      }

      if (row.eventName === "OrderRefunded") {
        const customerMobile = str(payload.customerMobile);
        if (customerMobile.length > 5 && payload.source === "gateway_webhook") {
          await sendWa(logger, wa, {
            to: customerMobile,
            body: `Refund confirmed · ${str(payload.publicId)}. Amount will reflect per your bank’s timeline.`,
            buttons: ["Orders", "Menu"],
          });
        }
        logger.info({ event: LogEvent.OUTBOX_PROCESSED, source: payload.source }, "OrderRefunded");
      }

      if (row.eventName === "CookPayoutWebhook") {
        logger.info({ event: LogEvent.OUTBOX_PROCESSED, kind: payload.kind, status: payload.status, settlementId: payload.settlementId }, "CookPayoutWebhook");
      }

      if (row.eventName === "CookRouteAccountWebhook") {
        logger.info({ event: LogEvent.OUTBOX_PROCESSED, waEvent: payload.event, accountId: payload.accountId, cookId: payload.cookId }, "CookRouteAccountWebhook");
      }

      if (row.eventName === "PlatformSettlementProcessed") {
        logger.info({ event: LogEvent.OUTBOX_PROCESSED, settlementGatewayId: payload.settlementGatewayId, utr: payload.utr }, "PlatformSettlementProcessed");
      }

      if (row.eventName === "SettlementBatchCompleted") {
        logger.info({ event: LogEvent.SETTLEMENT_BATCH_COMPLETED, settlementId: payload.settlementId, status: payload.status, cookId: payload.cookId }, "SettlementBatchCompleted");
      }
    } catch (err) {
      const nextAttempts = attempts + 1;
      const lastError = err instanceof Error ? err.message : String(err);
      // Meta allowlist / undeliverable — do not retry forever (top GCP error).
      if (isNonRetryableWhatsAppError(err)) {
        logger.warn(
          {
            err,
            event: LogEvent.OUTBOX_SKIPPED,
            reason: "whatsapp_non_retryable",
            attempts: nextAttempts,
          },
          "outbox settled — non-retryable WhatsApp error",
        );
        await db
          .update(outbox)
          .set({
            attempts: nextAttempts,
            lastError,
            processedAt: new Date(),
          })
          .where(eq(outbox.id, row.id));
        continue;
      }
      logger.error({ err, event: LogEvent.OUTBOX_FAILED, attempts: nextAttempts }, "outbox handler failed");
      await db
        .update(outbox)
        .set({
          attempts: nextAttempts,
          lastError,
          ...(nextAttempts >= OUTBOX_MAX_ATTEMPTS
            ? { processedAt: new Date() }
            : {}),
        })
        .where(eq(outbox.id, row.id));
      continue;
    }

    logger.info({ event: LogEvent.OUTBOX_PROCESSED }, "outbox processed");
    await db
      .update(outbox)
      .set({ processedAt: new Date() })
      .where(eq(outbox.id, row.id));
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

import http from "node:http";

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

log.info({ event: LogEvent.WORKER_STARTED, pollMs: 3000 }, "worker started — polling outbox");
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
}, 3000);

processOutbox().catch((err) => log.error({ err }, "initial outbox poll failed"));
