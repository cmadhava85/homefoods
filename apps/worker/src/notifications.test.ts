/**
 * Worker WhatsApp notifications: one case per outbox event (recipient, key copy, buttons) plus the
 * delivery-failure branches (retry, non-retryable, parked after max attempts, kill switch) and the
 * ops ledger. Uses the mock WhatsApp provider against the real test DB.
 */
import "dotenv/config";
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  closeDb,
  cookProfiles,
  createDb,
  kitchenFollowers,
  orders,
  outbox,
  platformEventLedger,
  users,
  waInboundDedupe,
} from "@localmeals/db";
import {
  getWhatsAppProvider,
  resetWhatsAppProvider,
  type WhatsAppMessage,
} from "@localmeals/adapters";
import { drainOutboxOnce } from "./drainOutbox.js";
import { drainUntilEmpty } from "./drainUntilEmpty.js";
import { recordConfirmingStuckOnce, recordOutboxOpsFailure } from "./opsLedger.js";

process.env.MOCK_WHATSAPP = "true";
resetWhatsAppProvider();

type Mock = { sent: WhatsAppMessage[]; send: (m: WhatsAppMessage) => Promise<unknown> };
let seq = 0;
const mobile = () => `+9171${String(Date.now() + seq++).slice(-8)}`;

describe("worker outbox notifications", () => {
  const db = createDb();
  const wa = getWhatsAppProvider() as unknown as Mock;
  const allowed = { whatsappOutboundAllowed: async () => true, apiBase: "http://x" };

  async function enqueue(eventName: string, payload: Record<string, unknown>, attempts = 0) {
    const [row] = await db.insert(outbox).values({ eventName, payload, attempts }).returning();
    return row;
  }
  const sentTo = (to: string) => wa.sent.filter((m) => m.to === to);
  const reload = async (id: number) =>
    (await db.select().from(outbox).where(eq(outbox.id, id)))[0];

  before(async () => {
    await db.update(outbox).set({ processedAt: new Date() }).where(isNull(outbox.processedAt));
  });
  beforeEach(async () => {
    // Keep each case's batch to its own rows.
    await db.update(outbox).set({ processedAt: new Date() }).where(isNull(outbox.processedAt));
  });
  after(async () => {
    delete process.env.WHATSAPP_TMPL_ORDER_PAID;
    await closeDb(db);
  });

  const cases: Array<{
    name: string;
    event: string;
    payload: (m: string) => Record<string, unknown>;
    expect: Array<{ body: RegExp; buttons?: string[] }>;
  }> = [
    {
      name: "OrderCreated (single plate) asks the customer to pay",
      event: "OrderCreated",
      payload: (m) => ({ customerMobile: m, kitchenName: "CSK", publicId: "LM-AA11", qty: 2, itemName: "Meals", serviceDate: "2031-01-02", amountPaise: 16800, paymentUrl: "https://pay/x" }),
      expect: [{ body: /Pay to confirm · CSK[\s\S]*LM-AA11 · 2× Meals[\s\S]*Amount ₹168[\s\S]*Pay here: https:\/\/pay\/x[\s\S]*20 minutes/, buttons: ["Pay LM-AA11", "Orders", "Menu"] }],
    },
    {
      name: "OrderCreated (week cart) lists every day",
      event: "OrderCreated",
      payload: (m) => ({ customerMobile: m, kitchenName: "CSK", checkoutId: "CHK-BB22", lines: [{ serviceDate: "2031-01-02", qty: 1, itemName: "A" }, { serviceDate: "2031-01-03", qty: 1, itemName: "B" }] }),
      expect: [{ body: /CHK-BB22[\s\S]*2031-01-02 · 1× A[\s\S]*2031-01-03 · 1× B[\s\S]*Reply Pay/, buttons: ["Pay CHK-BB22", "Orders", "Menu"] }],
    },
    {
      name: "OrderCreated (child pays) tells the senior who pays",
      event: "OrderCreated",
      payload: (m) => ({ customerMobile: m, childPays: true, payerMobile: "+919800000002", publicId: "LM-CC33", amountPaise: 9000 }),
      expect: [{ body: /Waiting for payment[\s\S]*Total ₹90[\s\S]*Family \+919800000002/, buttons: ["Orders", "Menu"] }],
    },
    {
      name: "ChildPaysRequested goes to the payer",
      event: "ChildPaysRequested",
      payload: (m) => ({ payerMobile: m, seniorMobile: "+919800000003", kitchenName: "CSK", checkoutId: "CHK-DD44", amountPaise: 20000 }),
      expect: [{ body: /Family pay request · CSK[\s\S]*For \+919800000003[\s\S]*Amount ₹200[\s\S]*20 minutes/, buttons: ["Pay CHK-DD44", "Orders", "Menu"] }],
    },
    {
      name: "OrderCancelled (paid) mentions the refund",
      event: "OrderCancelled",
      payload: (m) => ({ customerMobile: m, publicId: "LM-EE55", itemName: "Meals", qty: 1, kitchenName: "CSK", wasPaid: true }),
      expect: [{ body: /Order cancelled · LM-EE55[\s\S]*Refund initiated/ }],
    },
    {
      name: "OrderCancelled (unpaid) says nothing was taken",
      event: "OrderCancelled",
      payload: (m) => ({ customerMobile: m, publicId: "LM-EE56", wasPaid: false }),
      expect: [{ body: /No payment was taken/ }],
    },
    {
      name: "CancelRequested asks the cook to accept/decline",
      event: "CancelRequested",
      payload: (m) => ({ cookMobile: m, publicId: "LM-FF66", itemName: "Meals", customerMobile: "+919800000004", serviceDate: "2031-01-02" }),
      expect: [{ body: /Cancel request[\s\S]*LM-FF66[\s\S]*Accept → full refund/, buttons: ["Accept LM-FF66", "Decline LM-FF66", "Status"] }],
    },
    {
      name: "CancelDeclined tells the customer the order stays",
      event: "CancelDeclined",
      payload: (m) => ({ customerMobile: m, publicId: "LM-GG77", reason: "Already cooking" }),
      expect: [{ body: /Kitchen kept your order · LM-GG77[\s\S]*Already cooking/, buttons: ["Orders", "Help"] }],
    },
    {
      name: "OrderStatusChanged DISPATCHED / DELIVERED / CANCEL_REQUESTED notify by default",
      event: "OrderStatusChanged",
      payload: (m) => ({ customerMobile: m, publicId: "LM-HH88", toStatus: "DISPATCHED", kitchenName: "CSK", itemName: "Meals" }),
      expect: [{ body: /On the way · LM-HH88[\s\S]*1× Meals from CSK/ }],
    },
    {
      name: "OrderStatusChanged DELIVERED asks for a rating",
      event: "OrderStatusChanged",
      payload: (m) => ({ customerMobile: m, publicId: "LM-HH89", toStatus: "DELIVERED" }),
      expect: [{ body: /Delivered · LM-HH89[\s\S]*star rating/ }],
    },
    {
      name: "OrderStatusChanged CANCEL_REQUESTED confirms the ask",
      event: "OrderStatusChanged",
      payload: (m) => ({ customerMobile: m, publicId: "LM-HH90", toStatus: "CANCEL_REQUESTED" }),
      expect: [{ body: /Asked kitchen to cancel · LM-HH90/ }],
    },
    {
      name: "OrderStatusChanged COOKING is silent unless lean opt-in",
      event: "OrderStatusChanged",
      payload: (m) => ({ customerMobile: m, publicId: "LM-HH91", toStatus: "COOKING" }),
      expect: [],
    },
    {
      name: "OrderStatusChanged COOKING with lean opt-in",
      event: "OrderStatusChanged",
      payload: (m) => ({ customerMobile: m, publicId: "LM-HH92", toStatus: "COOKING", leanWaOptIn: true }),
      expect: [{ body: /Cooking started · LM-HH92/ }],
    },
    {
      name: "OrderStatusChanged PACKED pickup wording",
      event: "OrderStatusChanged",
      payload: (m) => ({ customerMobile: m, publicId: "LM-HH93", toStatus: "PACKED", leanWaOptIn: true, fulfillmentMode: "PICKUP" }),
      expect: [{ body: /Ready · LM-HH93[\s\S]*Ready for pickup/ }],
    },
    {
      name: "OrderStatusChanged PACKED customer-arrange wording",
      event: "OrderStatusChanged",
      payload: (m) => ({ customerMobile: m, publicId: "LM-HH94", toStatus: "PACKED", leanWaOptIn: true, fulfillmentMode: "CUSTOMER_ARRANGE" }),
      expect: [{ body: /arrange your auto/ }],
    },
    {
      name: "FamilyLinkRequested invites the payer in plain language",
      event: "FamilyLinkRequested",
      payload: (m) => ({ payerMobile: m, seniorMobile: "+919800000005" }),
      expect: [{ body: /Family pay invite[\s\S]*\+919800000005 asked you to pay[\s\S]*Accept family/ }],
    },
    {
      name: "LateOrderRequested asks the cook",
      event: "LateOrderRequested",
      payload: (m) => ({ cookMobile: m, publicId: "LM-II10", itemName: "Meals", customerMobile: "+919800000006", deliveryTargetAddress: "Tower 1" }),
      expect: [{ body: /Late lunch request[\s\S]*LM-II10[\s\S]*Tower 1/, buttons: ["Accept LM-II10", "Decline LM-II10", "Late requests"] }],
    },
    {
      name: "LateOrderApproved sends the pay link",
      event: "LateOrderApproved",
      payload: (m) => ({ customerMobile: m, publicId: "LM-II11", kitchenName: "CSK", paymentUrl: "https://pay/y" }),
      expect: [{ body: /Late lunch accepted by CSK[\s\S]*Pay link: https:\/\/pay\/y/, buttons: ["Pay LM-II11", "Menu"] }],
    },
    {
      name: "LateOrderDeclined says no charge",
      event: "LateOrderDeclined",
      payload: (m) => ({ customerMobile: m, publicId: "LM-II12" }),
      expect: [{ body: /Late request LM-II12 declined[\s\S]*No payment was taken/ }],
    },
    {
      name: "OrderPaymentFailed offers retry",
      event: "OrderPaymentFailed",
      payload: (m) => ({ customerMobile: m, publicId: "LM-JJ13" }),
      expect: [{ body: /Payment failed · LM-JJ13[\s\S]*No money was taken/, buttons: ["Pay", "Orders"] }],
    },
    {
      name: "OrderRefunded (admin) notifies",
      event: "OrderRefunded",
      payload: (m) => ({ customerMobile: m, publicId: "LM-KK14", source: "admin" }),
      expect: [{ body: /Refund initiated · LM-KK14/ }],
    },
    {
      name: "OrderRefunded (paid after cancel) explains why",
      event: "OrderRefunded",
      payload: (m) => ({ customerMobile: m, publicId: "LM-KK15", source: "paid_after_terminal" }),
      expect: [{ body: /payment arrived after the order was cancelled/ }],
    },
    {
      name: "OrderRefunded from an unknown source is not sent",
      event: "OrderRefunded",
      payload: (m) => ({ customerMobile: m, publicId: "LM-KK16", source: "something_else" }),
      expect: [],
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const to = mobile();
      const row = await enqueue(c.event, c.payload(to));
      await drainOutboxOnce(db, allowed);
      const msgs = sentTo(to);
      assert.equal(msgs.length, c.expect.length, JSON.stringify(msgs.map((m) => m.body)));
      c.expect.forEach((e, i) => {
        assert.match(msgs[i].body, e.body);
        if (e.buttons) assert.deepEqual(msgs[i].buttons, e.buttons);
      });
      assert.ok((await reload(row.id)).processedAt, "row marked processed");
    });
  }

  it("TicketCreated WhatsApps every ADMIN_MOBILES number", async () => {
    const a = mobile();
    const b = mobile();
    const prev = process.env.ADMIN_MOBILES;
    process.env.ADMIN_MOBILES = `${a},${b}`;
    try {
      const row = await enqueue("TicketCreated", {
        ticketId: 42,
        category: "QUALITY",
        orderPublicId: "LM-TK01",
        source: "WEB",
        summary: "Cold rice",
        slaDueAt: "2031-01-02T10:00:00.000Z",
      });
      await drainOutboxOnce(db, allowed);
      assert.equal(sentTo(a).length, 1);
      assert.equal(sentTo(b).length, 1);
      assert.match(sentTo(a)[0].body ?? "", /New support ticket #42[\s\S]*QUALITY[\s\S]*LM-TK01[\s\S]*SLA due/);
      assert.ok((await reload(row.id)).processedAt);
    } finally {
      if (prev === undefined) delete process.env.ADMIN_MOBILES;
      else process.env.ADMIN_MOBILES = prev;
    }
  });

  it("OrderPaid notifies cook and customer; uses the template when configured", async () => {
    process.env.WHATSAPP_TMPL_ORDER_PAID = "order_paid_v1";
    try {
      const cook = mobile();
      const customer = mobile();
      await enqueue("OrderPaid", { cookMobile: cook, customerMobile: customer, publicId: "LM-LL17", itemName: "Meals", qty: 1, serviceDate: "2031-01-02" });
      await drainOutboxOnce(db, allowed);
      assert.equal(sentTo(cook).length, 1);
      assert.deepEqual(sentTo(cook)[0].buttons, ["Status", "Cooking", "Packed"]);
      const c = sentTo(customer);
      assert.equal(c.length, 1);
      assert.deepEqual(c[0].template, { name: "order_paid_v1", language: "en", bodyParams: ["LM-LL17", "Meals"] });
      assert.equal(c[0].buttons, undefined, "template path must not pretend reply buttons were sent");
    } finally {
      delete process.env.WHATSAPP_TMPL_ORDER_PAID;
    }
  });

  it("inside the 24 h customer window the free-form body is sent instead of a paid template", async () => {
    process.env.WHATSAPP_TMPL_ORDER_PAID = "order_paid_v1";
    try {
      const recent = mobile();
      const stale = mobile();
      await db.insert(waInboundDedupe).values([
        { wamid: `wamid.recent.${recent}`, fromMobile: recent },
        { wamid: `wamid.stale.${stale}`, fromMobile: stale, createdAt: new Date(Date.now() - 25 * 3600_000) },
      ]);
      for (const customer of [recent, stale]) {
        await enqueue("OrderPaid", { cookMobile: mobile(), customerMobile: customer, publicId: "LM-WW01", itemName: "Meals", qty: 1, serviceDate: "2031-01-02" });
      }
      await drainOutboxOnce(db, allowed);
      assert.equal(sentTo(recent).length, 1);
      assert.equal(sentTo(recent)[0].template, undefined, "window open → free-form");
      assert.match(sentTo(recent)[0].body ?? "", /LM-WW01/);
      assert.equal(sentTo(stale)[0].template?.name, "order_paid_v1", "window closed → template");
    } finally {
      delete process.env.WHATSAPP_TMPL_ORDER_PAID;
    }
  });

  it("push-mode wake drains every pending batch, not just the first 20 rows", async () => {
    const rows = [];
    for (let i = 0; i < 45; i++) rows.push(await enqueue("CutoffReached", { cookId: "x" }));
    const r = await drainUntilEmpty(db, allowed);
    assert.equal(r.exhausted, true);
    assert.ok(r.claimed >= 45 && r.batches >= 3, JSON.stringify(r));
    const left = await db
      .select({ id: outbox.id })
      .from(outbox)
      .where(and(inArray(outbox.id, rows.map((x) => x.id)), isNull(outbox.processedAt)));
    assert.equal(left.length, 0);
    assert.deepEqual(await drainUntilEmpty(db, allowed), { claimed: 0, batches: 0, exhausted: true });
  });

  it("logging-only events are processed without messages", async () => {
    const before = wa.sent.length;
    const rows = await Promise.all(
      ["CutoffReached", "CookPayoutWebhook", "CookRouteAccountWebhook", "PlatformSettlementProcessed", "SettlementBatchCompleted"].map(
        (e) => enqueue(e, { cookId: "x" }),
      ),
    );
    await drainOutboxOnce(db, allowed);
    assert.equal(wa.sent.length, before);
    for (const r of rows) assert.ok((await reload(r.id)).processedAt);
  });

  it("KitchenMenuPosted alerts followers but skips anyone who replied STOP", async () => {
    const cook = (await db.select().from(cookProfiles).limit(1))[0];
    const keep = mobile();
    const stopped = mobile();
    await db.insert(users).values([
      { mobileNumber: keep, fullName: "Keep", primaryAddress: "x", pinCode: "600119" },
      { mobileNumber: stopped, fullName: "Stop", primaryAddress: "x", pinCode: "600119", consents: { waMarketingOptOut: true } },
    ]);
    await db.insert(kitchenFollowers).values([
      { cookId: cook.id, customerMobile: keep },
      { cookId: cook.id, customerMobile: stopped },
    ]);
    try {
      await enqueue("KitchenMenuPosted", { cookId: cook.id, kitchenName: "CSK", cookSlug: cook.slugHandle, itemName: "Biryani", pricePaise: 12000, weekly: true });
      await drainOutboxOnce(db, allowed);
      assert.equal(sentTo(keep).length, 1);
      assert.match(sentTo(keep)[0].body, /posted a new plate[\s\S]*Biryani — ₹120 · weekly plate[\s\S]*Reply STOP/);
      assert.equal(sentTo(stopped).length, 0, "STOP must suppress marketing alerts");
    } finally {
      await db.delete(kitchenFollowers).where(inArray(kitchenFollowers.customerMobile, [keep, stopped]));
      await db.delete(users).where(inArray(users.mobileNumber, [keep, stopped]));
    }
  });

  it("kill switch: rows are settled without sending when outbound WhatsApp is disabled", async () => {
    const to = mobile();
    const row = await enqueue("OrderPaymentFailed", { customerMobile: to, publicId: "LM-MM18" });
    await drainOutboxOnce(db, { whatsappOutboundAllowed: async () => false, apiBase: "http://x" });
    assert.equal(sentTo(to).length, 0);
    const r = await reload(row.id);
    assert.ok(r.processedAt);
    assert.equal(r.lastError, "whatsapp_outbound_disabled");
  });

  it("a transient send failure is retried later (attempts++, not processed)", async () => {
    const to = mobile();
    const row = await enqueue("OrderPaymentFailed", { customerMobile: to, publicId: "LM-NN19" });
    const realSend = wa.send.bind(wa);
    wa.send = async (m) => {
      if (m.to === to) throw new Error("Meta 500");
      return realSend(m);
    };
    try {
      await drainOutboxOnce(db, allowed);
    } finally {
      wa.send = realSend;
    }
    const r = await reload(row.id);
    assert.equal(r.attempts, 1);
    assert.equal(r.processedAt, null);
    assert.equal(r.lastError, "Meta 500");
  });

  it("a non-retryable Meta error settles the row instead of retrying forever", async () => {
    const to = mobile();
    const row = await enqueue("OrderPaymentFailed", { customerMobile: to, publicId: "LM-OO20" });
    const realSend = wa.send.bind(wa);
    wa.send = async (m) => {
      if (m.to === to) throw new Error("(#131030) Recipient phone number not in allowed list");
      return realSend(m);
    };
    try {
      await drainOutboxOnce(db, allowed);
    } finally {
      wa.send = realSend;
    }
    const r = await reload(row.id);
    assert.ok(r.processedAt);
    assert.equal(r.attempts, 1);
  });

  it("rows at max attempts are parked and logged to the order timeline", async () => {
    const order = (await db.select().from(orders).limit(1))[0];
    assert.ok(order, "seeded DB has an order");
    const row = await enqueue("OrderPaymentFailed", { customerMobile: mobile(), publicId: order.publicId }, 8);
    await drainOutboxOnce(db, allowed);
    const r = await reload(row.id);
    assert.ok(r.processedAt);
    const ledger = await db
      .select()
      .from(platformEventLedger)
      .where(and(eq(platformEventLedger.orderId, order.id), eq(platformEventLedger.eventName, "OUTBOX_NOTIFY_FAILED")));
    assert.ok(ledger.some((l) => (l.rawPayload as { reason?: string }).reason === "max_attempts"));
  });

  it("ops ledger: failures without a matching order are not recorded; stuck-payment marks are deduped", async () => {
    assert.equal(
      await recordOutboxOpsFailure(db, { eventName: "X", payload: { publicId: "LM-NOPE" }, reason: "test" }),
      false,
    );
    const order = (await db.select().from(orders).limit(1))[0];
    const input = { orderId: order.id, publicId: order.publicId, customerMobile: order.customerMobile, cookId: order.cookId, stuckMs: 900_000 };
    // Re-runs on the same DB would otherwise find an older mark inside the dedupe window.
    await db
      .delete(platformEventLedger)
      .where(and(eq(platformEventLedger.orderId, order.id), eq(platformEventLedger.eventName, "PAYMENT_CONFIRMING_STUCK")));
    await recordConfirmingStuckOnce(db, input);
    await recordConfirmingStuckOnce(db, input);
    const marks = await db
      .select()
      .from(platformEventLedger)
      .where(and(eq(platformEventLedger.orderId, order.id), eq(platformEventLedger.eventName, "PAYMENT_CONFIRMING_STUCK")));
    assert.ok(marks.length >= 1);
    const recent = marks.filter((m) => Date.now() - new Date(m.createdAt).getTime() < 60_000);
    assert.equal(recent.length, 1, "second call within the dedupe window must not add a row");
  });
});
