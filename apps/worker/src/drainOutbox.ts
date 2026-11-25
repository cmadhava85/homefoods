import { eq, sql } from "drizzle-orm";
import type { Db } from "@localmeals/db";
import { outbox } from "@localmeals/db";
import { getWhatsAppProvider, isNonRetryableWhatsAppError } from "@localmeals/adapters";
import {
  formatOrderPaidCookWa,
  formatOrderPaidCustomerWa,
} from "@localmeals/domain";
import {
  LogEvent,
  createServiceLogger,
  maskMobile,
  readCorr,
} from "@localmeals/observability";
import { recordOutboxOpsFailure } from "./opsLedger.js";
import { cateringWaMessages } from "./cateringNotify.js";

const defaultLog = createServiceLogger("localmeals-worker");

export type DrainOutboxOptions = {
  /** Override feature-flag check (tests pass true). Default: fetch API meta/features. */
  whatsappOutboundAllowed?: () => Promise<boolean>;
  apiBase?: string;
  maxAttempts?: number;
  logger?: ReturnType<typeof createServiceLogger>;
};

function str(v: unknown) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function adminMobilesFromEnv(): string[] {
  const raw = process.env.ADMIN_MOBILES?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}

function rowLog(
  log: ReturnType<typeof createServiceLogger>,
  row: { id: number; eventName: string },
  payload: Record<string, unknown>,
) {
  const corr = readCorr(payload);
  const publicId =
    corr.publicId ||
    (typeof payload.publicId === "string" ? payload.publicId : undefined) ||
    (typeof payload.orderPublicId === "string" ? payload.orderPublicId : undefined);
  const customerMobile =
    typeof payload.customerMobile === "string" ? maskMobile(payload.customerMobile) : undefined;
  const cookSlug =
    typeof payload.cookSlug === "string" ? payload.cookSlug : undefined;
  const cookId = typeof payload.cookId === "string" ? payload.cookId : undefined;
  return log.child({
    outboxId: row.id,
    eventName: row.eventName,
    traceId: corr.traceId,
    requestId: corr.requestId,
    publicId: publicId ?? corr.publicId,
    checkoutId: corr.checkoutId,
    ...(customerMobile ? { customerMobile } : {}),
    ...(cookSlug ? { cookSlug } : {}),
    ...(cookId ? { cookId } : {}),
  });
}

async function sendWa(
  logger: ReturnType<typeof rowLog>,
  wa: ReturnType<typeof getWhatsAppProvider>,
  message: Parameters<ReturnType<typeof getWhatsAppProvider>["send"]>[0],
) {
  try {
    // Meta template messages cannot carry free-form body or reply buttons. Drop buttons so mock
    // / logs match what customers actually receive (templateOutsideWindow picks free-form inside 24h).
    const outbound = message.template
      ? { ...message, buttons: undefined }
      : message;
    await wa.send(outbound);
  } catch (err) {
    logger.error(
      { err, event: LogEvent.WA_SEND_FAILED, to: maskMobile(message.to) },
      "whatsapp send failed",
    );
    throw err;
  }
}

/**
 * Prefer approved Meta utility templates when configured (outside 24h window).
 * Env: WHATSAPP_TMPL_ORDER_PAID / ORDER_STATUS / REFUND / MENU_ALERT (+ optional _LANG).
 */
function templateFromEnv(
  kind: "ORDER_PAID" | "ORDER_STATUS" | "REFUND" | "MENU_ALERT",
  bodyParams: string[],
): { name: string; language: string; bodyParams: string[] } | undefined {
  const name = (process.env[`WHATSAPP_TMPL_${kind}`] ?? "").trim();
  if (!name) return undefined;
  const language =
    (process.env[`WHATSAPP_TMPL_${kind}_LANG`] ?? process.env.WHATSAPP_OTP_TEMPLATE_LANG ?? "en")
      .trim() || "en";
  return { name, language, bodyParams: bodyParams.map((p) => String(p).slice(0, 1024)) };
}

/** Refund message: credit part is instant; the rest goes back to the original UPI/bank. */
export function refundCopy(publicId: string, amountPaise: number, creditPaise: number): string {
  const rupees = (p: number) => (p / 100).toFixed(2);
  const bankPaise = Math.max(0, amountPaise - creditPaise);
  if (creditPaise > 0 && bankPaise === 0) {
    return `Refund done · ${publicId}. ₹${rupees(creditPaise)} added to your LocalMeals credit — used automatically on your next order.`;
  }
  if (creditPaise > 0) {
    return `Refund initiated · ${publicId}. ₹${rupees(creditPaise)} added to your LocalMeals credit; ₹${rupees(bankPaise)} returns to the same UPI/bank (usually within a few hours, up to 1–2 working days).`;
  }
  return `Refund initiated · ${publicId}. Returns to the same UPI/bank — usually within a few hours (up to 1–2 working days).`;
}

/** Meta's customer-service window is 24 h from the user's last message; keep a safety margin. */
const CUSTOMER_WINDOW_MS = 23.5 * 60 * 60 * 1000;

/**
 * Inside the 24 h window a free-form message is free and needs no template; marketing templates
 * (e.g. MENU_ALERT) are charged even there. So use the template only when the window is closed.
 */
async function templateOutsideWindow<T>(db: Db, to: string, tmpl: T | undefined): Promise<{ template?: T }> {
  if (!tmpl) return {};
  const since = new Date(Date.now() - CUSTOMER_WINDOW_MS).toISOString();
  // Inbound stores +E.164; normalize so +91… / 91… still match the open window.
  const digits = to.replace(/\D/g, "");
  const variants = [...new Set([to, digits ? `+${digits}` : "", digits].filter(Boolean))];
  const rows = (await db.execute(sql`
    SELECT 1 FROM wa_inbound_dedupe
    WHERE from_mobile IN (${sql.join(
      variants.map((v) => sql`${v}`),
      sql`, `,
    )}) AND created_at > ${since}::timestamptz
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0 ? {} : { template: tmpl };
}

/** Cache WA kill-switch so an idle worker does not hammer GET /meta/features every poll. */
const WA_OUTBOUND_CACHE_MS = Math.max(
  10_000,
  Number(process.env.WA_OUTBOUND_FLAG_CACHE_MS ?? 60_000),
);
let waOutboundCache: { at: number; allowed: boolean } | null = null;

async function defaultWhatsappOutboundAllowed(apiBase: string): Promise<boolean> {
  if (waOutboundCache && Date.now() - waOutboundCache.at < WA_OUTBOUND_CACHE_MS) {
    return waOutboundCache.allowed;
  }
  let allowed = true;
  try {
    const res = await fetch(`${apiBase}/meta/features`);
    if (res.ok) {
      const json = (await res.json()) as { flags?: Record<string, boolean> };
      if (json.flags && typeof json.flags.whatsapp_outbound_enabled === "boolean") {
        allowed = json.flags.whatsapp_outbound_enabled;
      }
    }
  } catch {
    /* fail open so jobs aren't stuck if API is down briefly */
  }
  waOutboundCache = { at: Date.now(), allowed };
  return allowed;
}

export async function drainOutboxOnce(
  db: Db,
  opts: DrainOutboxOptions = {},
): Promise<{ claimed: number }> {
  const log = opts.logger ?? defaultLog;
  const apiBase =
    opts.apiBase ??
    process.env.API_INTERNAL_URL ??
    `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
  const OUTBOX_MAX_ATTEMPTS =
    opts.maxAttempts ?? Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 8);
  const whatsappOutboundAllowed =
    opts.whatsappOutboundAllowed ??
    (() => defaultWhatsappOutboundAllowed(apiBase));

  // Claim a batch with a lease so overlapping drains (2 worker instances, or a slow tick overlapping
  // the next) never pick the same rows. Row locks alone end when this statement commits.
  const leaseSec = Math.max(30, Number(process.env.OUTBOX_LEASE_SEC ?? 120));
  const claimed = await db.execute(sql`
    update outbox
    set locked_until = now() + make_interval(secs => ${leaseSec})
    where id in (
      select id from outbox
      where processed_at is null
        and (locked_until is null or locked_until < now())
      order by id
      for update skip locked
      limit 20
    )
    returning id, event_name, payload, attempts, last_error, processed_at, created_at
  `);
  const rawRows = (
    Array.isArray(claimed) ? claimed : ((claimed as { rows?: unknown[] }).rows ?? [])
  ) as Array<Record<string, unknown>>;
  const rows = rawRows.map((r) => ({
    id: Number(r.id),
    eventName: String(r.event_name ?? r.eventName),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    attempts: Number(r.attempts ?? 0),
    lastError: (r.last_error ?? r.lastError ?? null) as string | null,
    processedAt: (r.processed_at ?? r.processedAt ?? null) as Date | null,
    createdAt: (r.created_at ?? r.createdAt) as Date,
  }));
  if (!rows.length) return { claimed: 0 };

  const wa = getWhatsAppProvider();
  const waOut = await whatsappOutboundAllowed();
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown>;
    const logger = rowLog(log, row, payload);
    const attempts = row.attempts ?? 0;
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      logger.warn(
        {
          event: "outbox.parked",
          reason: "max_attempts",
          attempts,
          lastError: row.lastError,
        },
        "outbox parked after max attempts",
      );
      await recordOutboxOpsFailure(db, {
        eventName: row.eventName,
        payload,
        reason: "max_attempts",
        lastError: row.lastError ?? `max_attempts_${OUTBOX_MAX_ATTEMPTS}`,
        attempts,
      }).catch(() => undefined);
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
        await recordOutboxOpsFailure(db, {
          eventName: row.eventName,
          payload,
          reason: "whatsapp_outbound_disabled",
          lastError: "whatsapp_outbound_disabled",
          attempts,
        }).catch(() => undefined);
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
        const channel = str(payload.channel) || "WEB_STOREFRONT";
        const lines = Array.isArray(payload.lines) ? payload.lines : null;
        const amountPaise = Number(payload.amountPaise ?? 0);
        const amountLabel = amountPaise > 0 ? `₹${(amountPaise / 100).toFixed(0)}` : null;
        const childPays = Boolean(payload.childPays);
        const payerMobile = str(payload.payerMobile);
        // Web checkout already opens the pay screen — don't spam a pay link.
        // WhatsApp-originated orders still need the link in chat.
        // Child-pays: tell the senior who's paying (payer gets ChildPaysRequested separately).
        const sendPayLink = channel === "WHATSAPP_BOT" && !childPays;
        const sendSeniorWaiting = childPays;

        if (!sendPayLink && !sendSeniorWaiting) {
          logger.info(
            { event: LogEvent.OUTBOX_SKIPPED, reason: "in_app_checkout", channel },
            "OrderCreated WA skipped — customer pays in app; notify on paid/failed",
          );
        } else if (customerMobile.length > 5) {
          let body: string;
          const holdNote =
            "Reserved for 20 minutes. Pay now to confirm — if payment isn’t completed, this hold cancels automatically (no charge).";
          if (sendSeniorWaiting) {
            body = [
              `⏳ Waiting for payment · ${kitchen}`,
              checkoutId || pid,
              amountLabel ? `Total ${amountLabel}` : null,
              payerMobile
                ? `Family ${payerMobile} needs to complete UPI.`
                : "A family member needs to complete UPI.",
              "",
              "Reserved for 20 minutes. If they don’t pay in time, this hold cancels automatically (no charge).",
            ]
              .filter(Boolean)
              .join("\n");
          } else if (lines && lines.length) {
            const dayLines = lines
              .map((l) => {
                const line = l as Record<string, unknown>;
                return `· ${str(line.serviceDate)} · ${line.qty ?? 1}× ${str(line.itemName) || "item"}`;
              })
              .join("\n");
            body = [
              `⏳ Pay to confirm · ${kitchen}`,
              checkoutId || pid,
              dayLines,
              amountLabel ? `Total ${amountLabel}` : null,
              payUrl ? `Pay here: ${payUrl}` : "Reply Pay to open UPI.",
              "",
              holdNote,
            ]
              .filter(Boolean)
              .join("\n");
          } else {
            body = [
              `⏳ Pay to confirm · ${kitchen}`,
              `${pid} · ${payload.qty ?? 1}× ${str(payload.itemName) || "item"}`,
              payload.serviceDate ? `For ${str(payload.serviceDate)}` : null,
              amountLabel ? `Amount ${amountLabel}` : null,
              payUrl ? `Pay here: ${payUrl}` : "Reply Pay to open UPI.",
              "",
              holdNote,
            ]
              .filter(Boolean)
              .join("\n");
          }

          await sendWa(logger, wa, {
            to: customerMobile,
            body,
            buttons: sendSeniorWaiting
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
              payUrl ? `Pay here: ${payUrl}` : "Open My orders → Pay now.",
              "",
              "Their plate is reserved for 20 minutes. Pay now to confirm — if payment isn’t completed, this hold cancels automatically (no charge).",
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
          const tmpl = templateFromEnv("ORDER_PAID", [
            str(payload.publicId) || "order",
            str(payload.itemName) || "plate",
          ]);
          await sendWa(logger, wa, {
            to: customerMobile,
            body: customerBody,
            buttons: ["Orders", "Menu"],
            ...(await templateOutsideWindow(db, customerMobile, tmpl)),
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
            payload.wasPaid
              ? "Refund initiated. Money returns to the same UPI/bank — usually within a few hours (up to 1–2 working days)."
              : "No payment was taken.",
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
        // High-value customer pings by default; lean opt-in adds COOKING / Ready.
        const to = str(payload.toStatus);
        const customerMobile = str(payload.customerMobile);
        const publicId = str(payload.publicId);
        const kitchen = str(payload.kitchenName) || "kitchen";
        const itemLine = `${payload.qty ?? 1}× ${str(payload.itemName) || "plate"} from ${kitchen}`;
        const leanOn = payload.leanWaOptIn === true;
        const fulfillment = str(payload.fulfillmentMode) || "DELIVERY";

        if (customerMobile.length > 5 && to === "DISPATCHED") {
          const tmpl = templateFromEnv("ORDER_STATUS", [publicId || "order", "on the way"]);
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [`🛵 On the way · ${publicId}`, itemLine].join("\n"),
            buttons: ["Orders"],
            ...(await templateOutsideWindow(db, customerMobile, tmpl)),
          });
        }
        if (customerMobile.length > 5 && to === "DELIVERED") {
          const tmpl = templateFromEnv("ORDER_STATUS", [publicId || "order", "delivered"]);
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [
              `✅ Delivered · ${publicId}. Enjoy your lunch!`,
              "",
              "How was it? Open My orders and leave a quick star rating — it helps neighbours choose a kitchen.",
            ].join("\n"),
            buttons: ["Orders", "Menu"],
            ...(await templateOutsideWindow(db, customerMobile, tmpl)),
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
        if (customerMobile.length > 5 && leanOn && to === "COOKING") {
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [`👩‍🍳 Cooking started · ${publicId}`, itemLine].join("\n"),
            buttons: ["Orders"],
          });
        }
        if (customerMobile.length > 5 && leanOn && to === "PACKED") {
          const readyLine =
            fulfillment === "PICKUP"
              ? "Ready for pickup — show your order code at the landmark."
              : fulfillment === "CUSTOMER_ARRANGE"
                ? "Ready — arrange your auto/porter to collect."
                : "Packed and almost on the way.";
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [`📦 Ready · ${publicId}`, itemLine, readyLine].join("\n"),
            buttons: ["Orders"],
          });
        }
        if (to === "COOKING" || to === "PACKED" || to === "PAID") {
          logger.info(
            { event: LogEvent.OUTBOX_PROCESSED, toStatus: to, leanOn },
            "OrderStatusChanged",
          );
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
                ? `${seniorMobile} asked you to pay for their LocalMeals order.`
                : "A family member asked you to pay for their LocalMeals order.",
              "",
              "Reply Accept family — we’ll send you the pay link when they order.",
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
        const optedOut = async (mobile: string) => {
          try {
            const row = await db.query.users.findFirst({
              where: (t, { eq: e }) => e(t.mobileNumber, mobile),
            });
            const consents = (row?.consents ?? {}) as Record<string, unknown>;
            return consents.waMarketingOptOut === true;
          } catch {
            return false;
          }
        };
        const body = [
          `📣 ${kitchenName} posted a new plate`,
          `${itemName}${pricePaise ? ` — ₹${(pricePaise / 100).toFixed(0)}` : ""} · ${when}`,
          "",
          cookSlug ? `Reply Menu to see ${kitchenName}, or Week for multi-day.` : "Reply Menu to browse.",
          "Reply STOP to pause menu alerts.",
        ].join("\n");
        const tmpl = templateFromEnv("MENU_ALERT", [kitchenName, itemName]);
        for (const f of followers) {
          if (await optedOut(f.customerMobile)) continue;
          await sendWa(logger, wa, {
            to: f.customerMobile,
            body,
            buttons: cookSlug ? ["Menu", "Week", "Orders"] : ["Menu", "Orders"],
            ...(await templateOutsideWindow(db, f.customerMobile, tmpl)),
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
        const pid = str(payload.publicId);
        const checkoutId = str(payload.checkoutId);
        const payUrl = str(payload.paymentUrl);
        const payRef = checkoutId || pid;
        if (customerMobile.length > 5) {
          await sendWa(logger, wa, {
            to: customerMobile,
            body: [
              `⚠️ Payment failed · ${payRef || "order"}`,
              "No money was taken.",
              payUrl ? `Pay here: ${payUrl}` : "Reply Pay to try again, or open Orders.",
            ]
              .filter(Boolean)
              .join("\n"),
            buttons: payRef
              ? [`Pay ${payRef}`, "Orders"].slice(0, 3)
              : ["Pay", "Orders"],
          });
          logger.info({ event: LogEvent.OUTBOX_PROCESSED, channel: "whatsapp", toRole: "customer" }, "OrderPaymentFailed notified");
        }
      }

      if (row.eventName === "OrderRefunded") {
        const customerMobile = str(payload.customerMobile);
        const notifySources = new Set(["gateway_webhook", "admin", "paid_after_terminal"]);
        if (customerMobile.length > 5 && notifySources.has(str(payload.source))) {
          const reason =
            payload.source === "paid_after_terminal"
              ? `Refund for ${str(payload.publicId)} — payment arrived after the order was cancelled. Returns to the same UPI/bank (usually a few hours).`
              : refundCopy(str(payload.publicId), Number(payload.amountPaise ?? 0), Number(payload.creditPaise ?? 0));
          const tmpl = templateFromEnv("REFUND", [str(payload.publicId) || "order"]);
          await sendWa(logger, wa, {
            to: customerMobile,
            body: reason,
            buttons: ["Orders", "Menu"],
            ...(await templateOutsideWindow(db, customerMobile, tmpl)),
          });
        }
        logger.info({ event: LogEvent.OUTBOX_PROCESSED, source: payload.source }, "OrderRefunded");
      }

      if (row.eventName === "TicketCreated") {
        const ticketId = payload.ticketId;
        const category = str(payload.category) || "OTHER";
        const orderPublicId = str(payload.orderPublicId) || "—";
        const slaDueAt = str(payload.slaDueAt) || "—";
        const source = str(payload.source) || "WEB";
        const summary = str(payload.summary).slice(0, 160);
        const admins = adminMobilesFromEnv();
        const body = [
          `New support ticket #${ticketId}`,
          `Source: ${source} · ${category}`,
          `Order: ${orderPublicId}`,
          `SLA due: ${slaDueAt}`,
          summary ? `Note: ${summary}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        for (const to of admins) {
          await sendWa(logger, wa, { to, body });
        }
        logger.info(
          {
            event: LogEvent.OUTBOX_PROCESSED,
            channel: "whatsapp",
            toRole: "admin",
            ticketId,
            adminCount: admins.length,
          },
          "TicketCreated notified",
        );
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

      if (row.eventName.startsWith("Catering")) {
        for (const message of cateringWaMessages(row.eventName, payload)) {
          await sendWa(logger, wa, message);
        }
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
        await recordOutboxOpsFailure(db, {
          eventName: row.eventName,
          payload,
          reason: "whatsapp_non_retryable",
          lastError,
          attempts: nextAttempts,
        }).catch(() => undefined);
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
      if (nextAttempts >= OUTBOX_MAX_ATTEMPTS) {
        await recordOutboxOpsFailure(db, {
          eventName: row.eventName,
          payload,
          reason: "max_attempts",
          lastError,
          attempts: nextAttempts,
        }).catch(() => undefined);
      }
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

    logger.info(
      {
        event: LogEvent.OUTBOX_PROCESSED,
        outboxEvent: row.eventName,
      },
      "outbox processed",
    );
    await db
      .update(outbox)
      .set({ processedAt: new Date() })
      .where(eq(outbox.id, row.id));
  }
  return { claimed: rows.length };
}

