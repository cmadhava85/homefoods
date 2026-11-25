import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  knownErrorKey,
  localizeError,
  localizedDishName,
  localizedMealPeriod,
  localizedWeekday,
  parseLocale,
  t,
  validateAddressLine,
  validateFullName,
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
    assert.equal(parseLocale(null), "en");
    assert.equal(parseLocale(""), "en");
  });
});

describe("t", () => {
  it("interpolates and falls back", () => {
    assert.match(t("en", "pay.mockCta", { amount: "120" }), /₹120/);
    // Tamil uses real Tamil words, not English in Latin or Tamil script.
    assert.equal(t("ta", "nav.account"), "கணக்கு");
    assert.match(t("ta", "home.tagline"), /மதிய உணவு/);
    assert.match(t("en", "pay.mockCta"), /\{amount\}|₹/);
    assert.equal(t("en", "pay.mockCta", { amount: "120", extra: 1 }), t("en", "pay.mockCta", { amount: "120" }));
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

  it("covers sanitizers and patterned messages", () => {
    assert.equal(localizeError("en", "   "), t("en", "error.generic"));
    assert.equal(localizeError("en", "duplicate key value violates unique constraint"), t("en", "error.conflict"));
    assert.equal(localizeError("en", "ECONNREFUSED 127.0.0.1"), t("en", "error.generic"));
    assert.equal(localizeError("en", "You already have a home address"), t("en", "error.addressExists", { label: "HOME" }));
    assert.equal(localizeError("en", "No work address saved"), t("en", "error.noLabelAddress", { label: "WORK" }));
    assert.equal(localizeError("en", "totally unknown boom"), "totally unknown boom");
    assert.equal(knownErrorKey(""), null);
    assert.equal(knownErrorKey("error.otpInvalid"), "error.otpInvalid");
    assert.equal(knownErrorKey("Choose a delivery address"), "error.chooseAddress");
  });
});

describe("validators", () => {
  it("checks mobile otp pin", () => {
    assert.equal(validateMobile(""), "login.mobileRequired");
    assert.equal(validateMobile("123"), "login.mobileInvalid");
    assert.equal(validateMobile("+919840111111"), null);
    assert.equal(validateOtp(""), "login.otpRequired");
    assert.equal(validateOtp("12"), "login.otpInvalid");
    assert.equal(validateOtp("123456"), null);
    assert.equal(validatePin("60011"), "account.pinInvalid");
    assert.equal(validatePin("600119"), null);
    assert.equal(validateFullName("A"), "account.nameRequired");
    assert.equal(validateFullName("Ann"), null);
    assert.equal(validateAddressLine("ab"), "address.lineRequired");
    assert.equal(validateAddressLine("Tower E 1104"), null);
  });
});

describe("display helpers", () => {
  it("picks dish name and labels", () => {
    assert.equal(localizedDishName("en", { itemName: "Sambar", itemNameTa: "சாம்பார்" }), "Sambar");
    assert.equal(localizedDishName("ta", { itemName: "Sambar", itemNameTa: "சாம்பார்" }), "சாம்பார்");
    assert.equal(localizedDishName("ta", { itemName: "Sambar", itemNameTa: "  " }), "Sambar");
    assert.match(localizedWeekday("en", 1), /\w+/);
    assert.match(localizedWeekday("ta", -1), /\S+/);
    assert.equal(localizedMealPeriod("en", "BREAKFAST"), t("en", "wa.meal.breakfast"));
    assert.equal(localizedMealPeriod("en", "DINNER"), t("en", "wa.meal.dinner"));
    assert.equal(localizedMealPeriod("en", "LUNCH"), t("en", "wa.meal.lunch"));
    assert.equal(localizedMealPeriod("en", "OTHER"), t("en", "wa.meal.lunch"));
  });
});
