import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  classifyPaymentWebhook,
  gatewayIdempotencyHeader,
  getPaymentProvider,
  MockPaymentProvider,
  PAYMENT_LINK_TTL_SEC,
  paymentLinkExpireBy,
  RAZORPAY_MIN_LINK_TTL_SEC,
  RazorpayPaymentProvider,
  UNPAID_HOLD_TTL_SEC,
} from "./payments.js";

describe("MockPaymentProvider", () => {
  it("creates deterministic mock txn and payment URL", async () => {
    process.env.MOCK_PAYMENTS = "true";
    process.env.WEB_ORIGIN = "http://localhost:3000";
    const pay = new MockPaymentProvider();
    const result = await pay.createPayment({
      orderPublicId: "LM-1001",
      amountPaise: 10800,
      customerMobile: "+919840111111",
      idempotencyKey: "k1",
    });
    assert.equal(result.provider, "mock");
    assert.equal(result.gatewayTxnId, "mock_txn_LM-1001");
    assert.equal(result.paymentUrl, "http://localhost:3000/pay/LM-1001?txn=mock_txn_LM-1001");
    assert.equal(pay.verifyWebhookSignature({}, "{}"), true);
  });

  it("getPaymentProvider returns mock by default", () => {
    process.env.MOCK_PAYMENTS = "true";
    assert.ok(getPaymentProvider() instanceof MockPaymentProvider);
  });
});

describe("RazorpayPaymentProvider", () => {
  it("verifies HMAC signature over raw body", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
    const pay = new RazorpayPaymentProvider();
    const raw = JSON.stringify({ event: "payment_link.paid" });
    const sig = createHmac("sha256", "whsec_test").update(raw).digest("hex");
    assert.equal(pay.verifyWebhookSignature({ "x-razorpay-signature": sig }, raw), true);
    assert.equal(pay.verifyWebhookSignature({ "x-razorpay-signature": "deadbeef" }, raw), false);
  });

  it("sends expire_by beyond Razorpay's 15-minute minimum, even if a shorter one is requested", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_k";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_s";
    const sent: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ id: "plink_t", short_url: "https://rzp.io/t" }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      const pay = new RazorpayPaymentProvider();
      const before = Math.floor(Date.now() / 1000);
      await pay.createPayment({
        orderPublicId: "LM-T1",
        amountPaise: 1000,
        customerMobile: "+919840111111",
        idempotencyKey: "k-default",
      });
      await pay.createPayment({
        orderPublicId: "LM-T2",
        amountPaise: 1000,
        customerMobile: "+919840111111",
        idempotencyKey: "k-short",
        expireAtUnix: before + 60,
      });
      for (const body of sent) {
        const ttl = Number(body.expire_by) - before;
        assert.ok(ttl > RAZORPAY_MIN_LINK_TTL_SEC, `expire_by only ${ttl}s ahead`);
      }
      assert.equal(Number(sent[0].expire_by) - before >= PAYMENT_LINK_TTL_SEC, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("uses referenceId / callbackUrl when given (one booking, several links)", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_k";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_s";
    const sent: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ id: "plink_c", short_url: "https://rzp.io/c" }), {
        status: 200,
      });
    }) as typeof fetch;
    try {
      await new RazorpayPaymentProvider().createPayment({
        orderPublicId: "CAT-AB12",
        referenceId: "CAT-AB12-B1",
        callbackUrl: "https://web.example/catering/bookings/CAT-AB12",
        amountPaise: 1000,
        customerMobile: "+919840111111",
        idempotencyKey: "k-cat",
      });
      assert.equal(sent[0].reference_id, "CAT-AB12-B1");
      assert.equal(sent[0].callback_url, "https://web.example/catering/bookings/CAT-AB12");
      assert.equal((sent[0].notes as Record<string, string>).orderPublicId, "CAT-AB12");
    } finally {
      globalThis.fetch = realFetch;
    }
    const mock = await new MockPaymentProvider().createPayment({
      orderPublicId: "CAT-AB12",
      referenceId: "CAT-AB12-A1",
      callbackUrl: "http://web/catering/bookings/CAT-AB12",
      amountPaise: 1000,
      customerMobile: "+919840111111",
      idempotencyKey: "k-cat-mock",
    });
    assert.equal(mock.gatewayTxnId, "mock_txn_CAT-AB12-A1");
    assert.equal(mock.paymentUrl, "http://web/catering/bookings/CAT-AB12?txn=mock_txn_CAT-AB12-A1");
  });
});

describe("RazorpayPaymentProvider refunds", () => {
  it("always requests normal-speed refunds (no Instant Refund fee)", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_k";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_s";
    const sent: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(JSON.stringify({ id: "rfnd_t", payment_id: "pay_t", amount: 500 }), { status: 200 });
    }) as typeof fetch;
    try {
      await new RazorpayPaymentProvider().refundPayment({ paymentId: "pay_t", amountPaise: 500 });
      assert.equal(sent[0].speed, "normal");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("payment link / unpaid hold TTLs", () => {
  it("hold outlives the link, and the link outlives Razorpay's minimum", () => {
    assert.ok(PAYMENT_LINK_TTL_SEC > RAZORPAY_MIN_LINK_TTL_SEC);
    assert.ok(UNPAID_HOLD_TTL_SEC > PAYMENT_LINK_TTL_SEC);
    const now = 1_700_000_000_000;
    assert.equal(paymentLinkExpireBy(now), now / 1000 + PAYMENT_LINK_TTL_SEC);
    assert.equal(
      paymentLinkExpireBy(now, now / 1000 + 5),
      now / 1000 + RAZORPAY_MIN_LINK_TTL_SEC + 60,
    );
  });
});

describe("classifyPaymentWebhook", () => {
  it("classifies payment_link.paid", () => {
    const e = classifyPaymentWebhook({
      event: "payment_link.paid",
      payload: {
        payment_link: {
          entity: {
            id: "plink_abc",
            amount_paid: 10800,
            notes: { orderPublicId: "LM-1" },
          },
        },
        payment: { entity: { id: "pay_xyz" } },
      },
    });
    assert.equal(e.kind, "PAYMENT_CAPTURED");
    assert.equal(e.gatewayTxnId, "plink_abc");
    assert.equal(e.paymentId, "pay_xyz");
    assert.equal(e.orderPublicId, "LM-1");
  });

  it("mock refund + transfer helpers work", async () => {
    const pay = new MockPaymentProvider();
    const rf = await pay.refundPayment({ paymentId: "mock_txn_LM-1", amountPaise: 100 });
    assert.match(rf.refundId, /^mock_rfnd_/);
    const tr = await pay.transferToLinkedAccount({
      accountId: "acc_cook",
      amountPaise: 5000,
      notes: { settlementId: "1" },
    });
    assert.match(tr.transferId, /^mock_trf_/);
  });

  it("ignores payment.failed (UPI retry — link may still succeed)", () => {
    const e = classifyPaymentWebhook({
      event: "payment.failed",
      payload: {
        payment: { entity: { id: "pay_x", notes: { gatewayTxnId: "plink_1" } } },
      },
    });
    assert.equal(e.kind, "IGNORED");
    assert.equal(e.gatewayTxnId, "plink_1");
  });

  it("classifies payment.captured using plink notes, not order_ id", () => {
    const e = classifyPaymentWebhook({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: "pay_ok",
            amount: 11200,
            order_id: "order_rzp_internal",
            notes: { orderPublicId: "LM-1", payment_link_id: "plink_abc" },
          },
        },
      },
    });
    assert.equal(e.kind, "PAYMENT_CAPTURED");
    assert.equal(e.gatewayTxnId, "plink_abc");
    assert.equal(e.orderPublicId, "LM-1");
    assert.equal(e.paymentId, "pay_ok");
  });

  it("classifies refund.processed", () => {
    const e = classifyPaymentWebhook({
      event: "refund.processed",
      payload: {
        refund: { entity: { id: "rfnd_1", amount: 5000, payment_id: "pay_1" } },
        payment: { entity: { id: "pay_1", notes: { gatewayTxnId: "plink_1" } } },
      },
    });
    assert.equal(e.kind, "REFUND_PROCESSED");
    assert.equal(e.refundId, "rfnd_1");
    assert.equal(e.gatewayTxnId, "plink_1");
  });

  it("classifies transfer.processed (cook Route payout)", () => {
    const e = classifyPaymentWebhook({
      event: "transfer.processed",
      payload: {
        transfer: {
          entity: {
            id: "trf_1",
            amount: 8000,
            recipient: "acc_cook",
            notes: { gatewayBatchId: "mock_settle_x" },
          },
        },
      },
    });
    assert.equal(e.kind, "TRANSFER_PROCESSED");
    assert.equal(e.transferId, "trf_1");
    assert.equal(e.settlementGatewayId, "mock_settle_x");
  });

  it("classifies payout.processed", () => {
    const e = classifyPaymentWebhook({
      event: "payout.processed",
      payload: {
        payout: { entity: { id: "pout_1", amount: 8000, utr: "UTR123", status: "processed" } },
      },
    });
    assert.equal(e.kind, "PAYOUT_PROCESSED");
    assert.equal(e.utr, "UTR123");
  });

  it("classifies settlement.processed", () => {
    const e = classifyPaymentWebhook({
      event: "settlement.processed",
      payload: {
        settlement: { entity: { id: "setl_1", amount: 1524, utr: "AXIS1" } },
      },
    });
    assert.equal(e.kind, "SETTLEMENT_PROCESSED");
    assert.equal(e.settlementGatewayId, "setl_1");
  });

  it("ignores unknown events safely", () => {
    const e = classifyPaymentWebhook({ event: "invoice.paid", payload: {} });
    assert.equal(e.kind, "IGNORED");
  });
});

describe("gatewayIdempotencyHeader", () => {
  it("keeps short keys and hashes long ones without tail collisions", () => {
    assert.equal(gatewayIdempotencyHeader("chk_abc"), "chk_abc");
    const base = `std|+919840111111|4f4d9109-40da-4865-bac8-12454517ed32|LUNCH|2026-11-23|8400|10|NORMAL`;
    const a = gatewayIdempotencyHeader(base);
    const b = gatewayIdempotencyHeader(`${base}|addl|LM-1519B81EB3`);
    assert.equal(a.length, 64);
    assert.equal(b.length, 64);
    assert.notEqual(a, b);
  });
});

describe("Razorpay UPI QR (pickup)", () => {
  it("creates a single-use fixed-amount QR and closes it on cancel", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_k";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_s";
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(JSON.stringify({ id: "qr_T1", image_url: "https://rzp.io/i/qr" }), { status: 200 });
    }) as typeof fetch;
    try {
      const pay = new RazorpayPaymentProvider();
      const before = Math.floor(Date.now() / 1000);
      const qr = await pay.createUpiQr({ orderPublicId: "LM-Q1", amountPaise: 9000, customerMobile: "+919840111111", idempotencyKey: "k" });
      assert.equal(qr.gatewayTxnId, "qr_T1");
      assert.equal(qr.qrImageUrl, "https://rzp.io/i/qr");
      assert.match(calls[0].url, /\/payments\/qr_codes$/);
      assert.equal(calls[0].body.type, "upi_qr");
      assert.equal(calls[0].body.usage, "single_use");
      assert.equal(calls[0].body.fixed_amount, true);
      assert.equal(calls[0].body.payment_amount, 9000);
      assert.ok(Number(calls[0].body.close_by) - before > RAZORPAY_MIN_LINK_TTL_SEC);
      await pay.cancelPaymentLink("qr_T1");
      assert.match(calls[1].url, /\/payments\/qr_codes\/qr_T1\/close$/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("classifies qr_code.credited as a capture keyed by the QR id", () => {
    const e = classifyPaymentWebhook({
      event: "qr_code.credited",
      payload: {
        qr_code: { entity: { id: "qr_T1", notes: { orderPublicId: "LM-Q1" } } },
        payment: { entity: { id: "pay_Q", amount: 9000, notes: {} } },
      },
    });
    assert.equal(e.kind, "PAYMENT_CAPTURED");
    assert.equal(e.gatewayTxnId, "qr_T1");
    assert.equal(e.paymentId, "pay_Q");
    assert.equal(e.amountPaise, 9000);
    assert.equal(e.orderPublicId, "LM-Q1");
  });
});
