/**
 * Razorpay webhook handling (handlePaymentWebhook) and the confirm-return / mock-confirm routes —
 * every event kind and every guard branch on the money path.
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import {
  closeDb,
  cookLedger,
  cookProfiles,
  createDb,
  orders,
  outbox,
  payments,
  platformEventLedger,
  settlements,
} from "@localmeals/db";
import {
  MockPaymentProvider,
  RazorpayPaymentProvider,
  type GatewayWebhookEvent,
} from "@localmeals/adapters";
import { lineTotalPaise } from "@localmeals/domain";
import { buildApp } from "./app.js";
import { handlePaymentWebhook } from "./services/paymentWebhooks.js";
import { markOrderPaid } from "./services/orders.js";
import { customerWithAddress, loginCook, testMobile } from "./testHelpers.js";

process.env.LUNCH_CUTOFF_HOUR = "23";
process.env.LUNCH_CUTOFF_MINUTE = "59";
process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

type Order = typeof orders.$inferSelect;
const SLUG = "csk-homemade-delights";
// Unique per run so reruns against the same DB never see earlier rows.
const RUN = `t${Date.now().toString(36)}_`;

describe("payment webhooks + confirm-return", () => {
  const db = createDb();
  const app = buildApp(db);
  let menuItemId = 0;
  let cookId = "";

  const ev = (e: Partial<GatewayWebhookEvent> & { kind: GatewayWebhookEvent["kind"] }) =>
    ({ event: e.kind.toLowerCase(), raw: {}, ...e }) as GatewayWebhookEvent;
  const reload = async (id: number) =>
    (await db.query.orders.findFirst({ where: eq(orders.id, id) }))!;
  const outboxFor = (eventName: string, key: string, value: string) =>
    db
      .select({ id: outbox.id })
      .from(outbox)
      .where(sql`${outbox.eventName} = ${eventName} and ${outbox.payload}->>${key} = ${value}`);

  async function placeOrder(): Promise<Order> {
    const c = await customerWithAddress(app, testMobile("89"));
    const res = await app.inject({
      method: "POST",
      url: "/orders",
      headers: c.headers,
      payload: { customerMobile: c.mobile, cookSlug: SLUG, menuItemId, qty: 1, spice: "NORMAL", addressId: c.addressId },
    });
    assert.equal(res.statusCode, 200, res.body);
    return reload(res.json().id);
  }
  async function paidOrder(): Promise<Order> {
    const o = await placeOrder();
    await markOrderPaid(db, { gatewayTxnId: o.gatewayTxnId!, paymentId: `pay_${o.publicId}` });
    return reload(o.id);
  }

  before(async () => {
    await app.ready();
    const cook = await loginCook(app, SLUG);
    await app.inject({
      method: "PATCH",
      url: `/cooks/${SLUG}/meal-settings/LUNCH`,
      headers: cook.headers,
      payload: { cutoffHour: 23, cutoffMinute: 59 },
    });
    const row = (await db.query.cookProfiles.findFirst({ where: eq(cookProfiles.slugHandle, SLUG) }))!;
    cookId = row.id;
    await db.update(cookProfiles).set({ maxDailyCapacity: 1000 }).where(eq(cookProfiles.id, cookId));
    menuItemId = (await app.inject({ method: "GET", url: `/kitchens/${SLUG}/menu` })).json().menus[0].id;
  });
  after(async () => {
    await db.update(cookProfiles).set({ maxDailyCapacity: 40 }).where(eq(cookProfiles.id, cookId));
    await app.close();
    await closeDb(db);
  });

  describe("PAYMENT_CAPTURED", () => {
    it("acks a capture with no link/order reference without touching orders", async () => {
      const r = await handlePaymentWebhook(db, ev({ kind: "PAYMENT_CAPTURED" }));
      assert.deepEqual(r, { ok: true, kind: "PAYMENT_CAPTURED", ignored: true, reason: "no_gateway_txn" });
    });

    it("acks (200) an unknown payment link so Razorpay stops retrying", async () => {
      const r = (await handlePaymentWebhook(db, ev({ kind: "PAYMENT_CAPTURED", gatewayTxnId: "plink_unknown_x" }))) as {
        ignored?: boolean;
        reason?: string;
      };
      assert.equal(r.ignored, true);
      assert.equal(r.reason, "order_not_found");
    });

    it("marks the order paid and audits the gateway event", async () => {
      const o = await placeOrder();
      await handlePaymentWebhook(
        db,
        ev({ kind: "PAYMENT_CAPTURED", gatewayTxnId: o.gatewayTxnId!, paymentId: "pay_cap_1", amountPaise: lineTotalPaise(o) }),
      );
      assert.equal((await reload(o.id)).status, "PAID");
      const audit = await db
        .select()
        .from(platformEventLedger)
        .where(and(eq(platformEventLedger.orderId, o.id), eq(platformEventLedger.eventName, "GATEWAY_PAYMENT_CAPTURED")));
      assert.equal(audit.length, 1);
    });

    it("rejects a capture whose amount does not match the order", async () => {
      const o = await placeOrder();
      await assert.rejects(
        handlePaymentWebhook(db, ev({ kind: "PAYMENT_CAPTURED", gatewayTxnId: o.gatewayTxnId!, amountPaise: 1 })),
        /does not match/,
      );
      assert.equal((await reload(o.id)).status, "AWAITING_PAYMENT");
    });
  });

  describe("PAYMENT_AUTHORIZED / PAYMENT_FAILED", () => {
    it("authorized moves AWAITING → CONFIRMING once; a repeat is a no-op", async () => {
      const o = await placeOrder();
      const e = ev({ kind: "PAYMENT_AUTHORIZED", gatewayTxnId: o.gatewayTxnId! });
      assert.equal(((await handlePaymentWebhook(db, e)) as { matched: number }).matched, 1);
      assert.equal((await reload(o.id)).status, "CONFIRMING_PAYMENT");
      assert.equal(((await handlePaymentWebhook(db, e)) as { matched: number }).matched, 0);
    });

    it("failed marks an unpaid order FAILED, records the charge failure, and notifies", async () => {
      const o = await placeOrder();
      const r = (await handlePaymentWebhook(db, ev({ kind: "PAYMENT_FAILED", gatewayTxnId: o.gatewayTxnId! }))) as { matched: number };
      assert.equal(r.matched, 1);
      assert.equal((await reload(o.id)).status, "FAILED");
      const charge = await db.query.payments.findFirst({
        where: and(eq(payments.orderId, o.id), eq(payments.kind, "CHARGE")),
      });
      assert.equal(charge?.status, "FAILED");
      assert.equal((await outboxFor("OrderPaymentFailed", "publicId", o.publicId)).length, 1);
    });

    it("a late 'failed' event never downgrades a paid order", async () => {
      const o = await paidOrder();
      const r = (await handlePaymentWebhook(db, ev({ kind: "PAYMENT_FAILED", gatewayTxnId: o.gatewayTxnId! }))) as { matched: number };
      assert.equal(r.matched, 0);
      assert.equal((await reload(o.id)).status, "PAID");
    });

    it("failed for an unknown link is audited and acked", async () => {
      const r = (await handlePaymentWebhook(db, ev({ kind: "PAYMENT_FAILED", gatewayTxnId: "plink_nope" }))) as { matched: number };
      assert.equal(r.matched, 0);
    });
  });

  describe("REFUND_PROCESSED / REFUND_FAILED", () => {
    it("a gateway refund on a paid order refunds it, holds settlement, and notifies once", async () => {
      const o = await paidOrder();
      const e = ev({ kind: "REFUND_PROCESSED", gatewayTxnId: o.gatewayTxnId!, refundId: `rfnd_${o.id}`, amountPaise: 5000 });
      const r = (await handlePaymentWebhook(db, e)) as { matched: number };
      assert.equal(r.matched, 1);
      const after1 = await reload(o.id);
      assert.equal(after1.status, "REFUNDED");
      assert.equal(after1.settlementHold, true);
      const refunds = await db.select().from(payments).where(and(eq(payments.orderId, o.id), eq(payments.kind, "REFUND")));
      assert.equal(refunds.length, 1);
      assert.equal(refunds[0].amountPaise, 5000);
      assert.equal((await outboxFor("OrderRefunded", "publicId", o.publicId)).length, 1);

      // Razorpay redelivers the same refund webhook — must ack, not error, and not duplicate.
      await handlePaymentWebhook(db, e);
      const again = await db.select().from(payments).where(and(eq(payments.orderId, o.id), eq(payments.kind, "REFUND")));
      assert.equal(again.length, 1);
      assert.equal((await outboxFor("OrderRefunded", "publicId", o.publicId)).length, 1);
    });

    it("a refund webhook for an order that was never paid is audited only", async () => {
      const o = await placeOrder();
      const r = (await handlePaymentWebhook(db, ev({ kind: "REFUND_PROCESSED", gatewayTxnId: o.gatewayTxnId!, refundId: "rfnd_unpaid" }))) as { matched: number };
      assert.equal(r.matched, 0);
      assert.equal((await reload(o.id)).status, "AWAITING_PAYMENT");
    });

    it("refund failed raises an ops event", async () => {
      await handlePaymentWebhook(db, ev({ kind: "REFUND_FAILED", refundId: RUN + "rfnd_fail", orderPublicId: "LM-X" }));
      assert.equal((await outboxFor("OrderRefundFailed", "refundId", RUN + "rfnd_fail")).length, 1);
    });
  });

  describe("cook payouts (Route transfers / payouts)", () => {
    async function settlementRow(gatewayBatchId: string | null) {
      // Pick a business date this cook has no settlement for (reruns share the DB).
      let date = "";
      for (let i = 0; i < 50 && !date; i++) {
        const d = `2018-${String(Math.floor(Math.random() * 12) + 1).padStart(2, "0")}-${String(Math.floor(Math.random() * 27) + 1).padStart(2, "0")}`;
        const taken = await db.query.settlements.findFirst({
          where: and(eq(settlements.cookId, cookId), eq(settlements.businessDate, d)),
        });
        if (!taken) date = d;
      }
      assert.ok(date, "no free settlement date");
      const [row] = await db
        .insert(settlements)
        .values({ cookId, businessDate: date, grossPaise: 10000, feesPaise: 0, clawbackPaise: 0, netPaise: 10000, orderCount: 1, gatewayBatchId, status: "TRANSFER_INITIATED" })
        .returning();
      return row;
    }

    it("matches by transfer id, updates status, and writes the cook ledger", async () => {
      const s = await settlementRow(`trf_${Date.now()}`);
      const r = (await handlePaymentWebhook(db, ev({ kind: "TRANSFER_PROCESSED", transferId: s.gatewayBatchId!, utr: "UTR1", amountPaise: 10000 }))) as { matched: number };
      assert.equal(r.matched, 1);
      const row = (await db.query.settlements.findFirst({ where: eq(settlements.id, s.id) }))!;
      assert.equal(row.status, "TRANSFER_PROCESSED");
      const ledger = await db.select().from(cookLedger).where(eq(cookLedger.settlementId, s.id));
      assert.equal(ledger.length, 1);
      assert.match(ledger[0].note ?? "", /UTR UTR1/);
    });

    it("falls back to notes.settlementId (appended transfers)", async () => {
      const s = await settlementRow("first_transfer_id");
      const r = (await handlePaymentWebhook(
        db,
        ev({ kind: "PAYOUT_FAILED", payoutId: "pout_unmatched", notes: { settlementId: String(s.id) } }),
      )) as { matched: number };
      assert.equal(r.matched, 1);
      assert.equal((await db.query.settlements.findFirst({ where: eq(settlements.id, s.id) }))!.status, "PAYOUT_FAILED");
    });

    it("an unmatched payout is acked and raised to ops", async () => {
      const r = (await handlePaymentWebhook(db, ev({ kind: "PAYOUT_REVERSED", payoutId: RUN + "pout_ghost" }))) as { matched: number };
      assert.equal(r.matched, 0);
      assert.equal((await outboxFor("CookPayoutWebhook", "gatewayId", RUN + "pout_ghost")).length, 1);
    });

    it("TRANSFER_FAILED and PAYOUT_PROCESSED update the status", async () => {
      const a = await settlementRow(`trf_f_${Date.now()}`);
      await handlePaymentWebhook(db, ev({ kind: "TRANSFER_FAILED", transferId: a.gatewayBatchId! }));
      assert.equal((await db.query.settlements.findFirst({ where: eq(settlements.id, a.id) }))!.status, "TRANSFER_FAILED");
      const b = await settlementRow(`pout_${Date.now()}`);
      await handlePaymentWebhook(db, ev({ kind: "PAYOUT_PROCESSED", payoutId: b.gatewayBatchId! }));
      assert.equal((await db.query.settlements.findFirst({ where: eq(settlements.id, b.id) }))!.status, "PAYOUT_PROCESSED");
    });
  });

  describe("platform settlement, Route account, ignored events", () => {
    it("platform settlement is queued for ops", async () => {
      const r = await handlePaymentWebhook(db, ev({ kind: "SETTLEMENT_PROCESSED", settlementGatewayId: RUN + "setl", utr: "AXIS9" }));
      assert.deepEqual(r, { ok: true, kind: "SETTLEMENT_PROCESSED", utr: "AXIS9" });
      assert.equal((await outboxFor("PlatformSettlementProcessed", "settlementGatewayId", RUN + "setl")).length, 1);
    });

    it("Route account events resolve the cook by linked account id", async () => {
      const acc = `acc_test_${Date.now()}`;
      const prev = (await db.query.cookProfiles.findFirst({ where: eq(cookProfiles.id, cookId) }))!.payoutBeneficiaryRef;
      await db.update(cookProfiles).set({ payoutBeneficiaryRef: acc }).where(eq(cookProfiles.id, cookId));
      try {
        const r = await handlePaymentWebhook(db, ev({ kind: "ROUTE_ACCOUNT", accountId: acc, status: "activated" }));
        assert.deepEqual(r, { ok: true, kind: "ROUTE_ACCOUNT", cookId, status: "activated" });
      } finally {
        await db.update(cookProfiles).set({ payoutBeneficiaryRef: prev }).where(eq(cookProfiles.id, cookId));
      }
    });

    it("unknown events are acknowledged as IGNORED", async () => {
      const r = await handlePaymentWebhook(db, ev({ kind: "IGNORED", event: "invoice.paid" }));
      assert.deepEqual(r, { ok: true, kind: "IGNORED", event: "invoice.paid" });
    });
  });

  describe("POST /payments/confirm-return", () => {
    const confirm = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/payments/confirm-return", payload });

    async function withLinkStatus<T>(
      Provider: typeof MockPaymentProvider | typeof RazorpayPaymentProvider,
      impl: () => Promise<{ status: string; paymentId: string | null; amountPaise?: number }>,
      fn: () => Promise<T>,
    ) {
      const proto = Provider.prototype as { getPaymentLinkStatus?: unknown };
      const real = proto.getPaymentLinkStatus;
      proto.getPaymentLinkStatus = impl;
      try {
        return await fn();
      } finally {
        proto.getPaymentLinkStatus = real;
      }
    }

    it("404 for an unknown order", async () => {
      assert.equal((await confirm({ publicId: "LM-DOESNOTEXIST" })).statusCode, 404);
    });

    it("an already-paid order short-circuits without calling the gateway", async () => {
      const o = await paidOrder();
      const res = await confirm({ publicId: o.publicId });
      assert.equal(res.statusCode, 200);
      assert.equal(res.json().status, "PAID");
    });

    it("refuses a payment link that is not the one stored on the order", async () => {
      const o = await placeOrder();
      const res = await confirm({ publicId: o.publicId, paymentLinkId: "plink_attacker" });
      assert.equal(res.statusCode, 400);
    });

    it("400 when the order has no payment link", async () => {
      const o = await placeOrder();
      await db.update(orders).set({ gatewayTxnId: null }).where(eq(orders.id, o.id));
      assert.equal((await confirm({ publicId: o.publicId })).statusCode, 400);
    });

    it("stays pending (never trusts the client) when the link is unpaid or the gateway errors", async () => {
      const o = await placeOrder();
      const created = await withLinkStatus(MockPaymentProvider, async () => ({ status: "created", paymentId: null }), () =>
        confirm({ publicId: o.publicId, linkStatus: "paid" }),
      );
      assert.equal(created.json().pending, true);
      const errored = await withLinkStatus(MockPaymentProvider, async () => { throw new Error("gateway down"); }, () =>
        confirm({ publicId: o.publicId }),
      );
      assert.equal(errored.json().pending, true);
      assert.equal((await reload(o.id)).status, "AWAITING_PAYMENT");
    });

    it("409 when the gateway amount differs; marks paid when it matches", async () => {
      const o = await placeOrder();
      const wrong = await withLinkStatus(MockPaymentProvider, async () => ({ status: "paid", paymentId: "pay_w", amountPaise: 1 }), () =>
        confirm({ publicId: o.publicId }),
      );
      assert.equal(wrong.statusCode, 409);
      const right = await withLinkStatus(
        MockPaymentProvider,
        async () => ({ status: "paid", paymentId: "pay_r", amountPaise: lineTotalPaise(o) }),
        () => confirm({ publicId: o.publicId }),
      );
      assert.equal(right.statusCode, 200, right.body);
      assert.equal((await reload(o.id)).status, "PAID");
    });

    it("live gateway: a missing or mismatched amount is refused", async () => {
      const o = await placeOrder();
      process.env.MOCK_PAYMENTS = "false";
      try {
        const missing = await withLinkStatus(RazorpayPaymentProvider, async () => ({ status: "paid", paymentId: "pay_m" }), () =>
          confirm({ publicId: o.publicId }),
        );
        assert.equal(missing.statusCode, 409);
        const mismatch = await withLinkStatus(
          RazorpayPaymentProvider,
          async () => ({ status: "paid", paymentId: "pay_x", amountPaise: lineTotalPaise(o) + 100 }),
          () => confirm({ publicId: o.publicId }),
        );
        assert.equal(mismatch.statusCode, 409);
      } finally {
        process.env.MOCK_PAYMENTS = "true";
      }
      assert.equal((await reload(o.id)).status, "AWAITING_PAYMENT");
    });
  });

  describe("POST /payments/mock-confirm guards", () => {
    it("rejects non-mock ids, and is disabled when payments are live", async () => {
      const bad = await app.inject({ method: "POST", url: "/payments/mock-confirm", payload: { gatewayTxnId: "plink_real" } });
      assert.equal(bad.statusCode, 400);
      process.env.MOCK_PAYMENTS = "false";
      try {
        const live = await app.inject({ method: "POST", url: "/payments/mock-confirm", payload: { gatewayTxnId: "mock_txn_x" } });
        assert.equal(live.statusCode, 403);
      } finally {
        process.env.MOCK_PAYMENTS = "true";
      }
    });
  });
});
