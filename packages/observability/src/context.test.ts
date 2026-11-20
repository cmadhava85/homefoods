import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CORR_PAYLOAD_KEY,
  bindTrace,
  getCorr,
  newTraceId,
  maskMobile,
  orderTriageFields,
  readCorr,
  runWithCorr,
  withCorr,
} from "./context.js";

describe("correlation", () => {
  it("embeds requestId and traceId from ALS into outbox payload", () => {
    runWithCorr({ requestId: "req-1", traceId: "trc_abc" }, () => {
      const payload = withCorr({ publicId: "LM-1", qty: 2 });
      assert.equal(payload[CORR_PAYLOAD_KEY].requestId, "req-1");
      assert.equal(payload[CORR_PAYLOAD_KEY].traceId, "trc_abc");
      assert.equal(payload[CORR_PAYLOAD_KEY].publicId, "LM-1");
      assert.equal(payload.traceId, "trc_abc");
      assert.equal(payload.qty, 2);
      assert.equal(getCorr()?.requestId, "req-1");
    });
  });

  it("bindTrace updates ALS for later withCorr", () => {
    runWithCorr({ requestId: "req-2" }, () => {
      bindTrace({ traceId: "trc_bound", publicId: "LM-9" });
      const payload = withCorr({ checkoutId: "CHK-1" });
      assert.equal(payload[CORR_PAYLOAD_KEY].traceId, "trc_bound");
      assert.equal(payload[CORR_PAYLOAD_KEY].publicId, "LM-9");
      assert.equal(payload[CORR_PAYLOAD_KEY].checkoutId, "CHK-1");
    });
  });

  it("newTraceId is stable-shaped", () => {
    const id = newTraceId();
    assert.match(id, /^trc_[a-f0-9]{32}$/);
  });

  it("readCorr falls back to publicId on payload", () => {
    const c = readCorr({ publicId: "LM-9", checkoutId: "chk-1", traceId: "trc_x" });
    assert.equal(c.publicId, "LM-9");
    assert.equal(c.checkoutId, "chk-1");
    assert.equal(c.traceId, "trc_x");
  });

  it("orderTriageFields keeps triage keys and omits empties", () => {
    const f = orderTriageFields({
      publicId: "LM-1",
      customerMobile: "+919900000001",
      cookSlug: "csk-homemade-delights",
      amountPaise: 8700,
      pinCode: "",
      kitchenName: null,
    });
    assert.equal(f.publicId, "LM-1");
    assert.equal(f.customerMobile, "+91***0000001");
    assert.equal(f.cookSlug, "csk-homemade-delights");
    assert.equal(f.amountPaise, 8700);
    assert.equal("pinCode" in f, false);
    assert.equal("kitchenName" in f, false);
  });

  it("maskMobile hides the first three local digits (skips +91)", () => {
    assert.equal(maskMobile("+919900000001"), "+91***0000001");
    assert.equal(maskMobile("919900000001"), "91***0000001");
    assert.equal(maskMobile("9900000001"), "***0000001");
    assert.equal(maskMobile(""), "");
  });
});
