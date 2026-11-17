import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  classifyPaymentWebhook,
  getPaymentProvider,
  MockPaymentProvider,
  RazorpayPaymentProvider,
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
