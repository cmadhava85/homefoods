import { describe, expect, it } from "vitest";
import { isExternalPaymentUrl, payPageHref } from "./payments";

describe("isExternalPaymentUrl", () => {
  it("accepts Razorpay short links", () => {
    expect(isExternalPaymentUrl("https://rzp.io/i/abc")).toBe(true);
    expect(isExternalPaymentUrl("https://api.razorpay.com/v1/checkout")).toBe(true);
  });

  it("rejects local mock pay pages and empty", () => {
    expect(isExternalPaymentUrl("http://localhost:3000/pay/LM-1?txn=mock_1")).toBe(false);
    expect(isExternalPaymentUrl(null)).toBe(false);
    expect(isExternalPaymentUrl(undefined)).toBe(false);
    expect(isExternalPaymentUrl("")).toBe(false);
    expect(isExternalPaymentUrl("not-a-url")).toBe(false);
  });
});

describe("payPageHref", () => {
  it("builds pay path with optional txn", () => {
    expect(payPageHref("LM-1")).toBe("/pay/LM-1");
    expect(payPageHref("CHK-1", "mock_abc")).toBe("/pay/CHK-1?txn=mock_abc");
  });
});
