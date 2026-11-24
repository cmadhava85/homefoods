import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  localizeError,
  parseLocale,
  t,
  validateMobile,
  validateOtp,
  validatePin,
} from "./index.js";

describe("parseLocale", () => {
  it("reads ta and en", () => {
    assert.equal(parseLocale("ta"), "ta");
    assert.equal(parseLocale("ta-IN"), "ta");
    assert.equal(parseLocale("en-US,en;q=0.9"), "en");
    assert.equal(parseLocale("fr"), "en");
  });
});

describe("t", () => {
  it("interpolates and falls back", () => {
    assert.match(t("en", "pay.mockCta", { amount: "120" }), /₹120/);
    // Tamil uses real Tamil words, not English in Latin or Tamil script.
    assert.equal(t("ta", "nav.account"), "கணக்கு");
    assert.match(t("ta", "home.tagline"), /மதிய உணவு/);
  });
});

describe("localizeError", () => {
  it("maps English and keys to Tamil", () => {
    assert.equal(localizeError("ta", "Choose a delivery address"), t("ta", "error.chooseAddress"));
    assert.equal(localizeError("ta", "error.otpInvalid"), t("ta", "error.otpInvalid"));
    assert.equal(
      localizeError("en", 'insert violates foreign key constraint "x"'),
      t("en", "error.generic"),
    );
  });
});

describe("validators", () => {
  it("checks mobile otp pin", () => {
    assert.equal(validateMobile(""), "login.mobileRequired");
    assert.equal(validateMobile("+919840111111"), null);
    assert.equal(validateOtp("12"), "login.otpInvalid");
    assert.equal(validateOtp("123456"), null);
    assert.equal(validatePin("60011"), "account.pinInvalid");
    assert.equal(validatePin("600119"), null);
  });
});
