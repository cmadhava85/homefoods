import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CORR_PAYLOAD_KEY,
  bindTrace,
  getCorr,
  newTraceId,
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
});
