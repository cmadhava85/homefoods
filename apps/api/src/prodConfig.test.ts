import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertProductionConfig } from "./prodConfig.js";

function setProdBase() {
  process.env.NODE_ENV = "production";
  process.env.DATABASE_URL = "postgres://u:p@localhost/db";
  process.env.AUTH_SECRET = "not-the-local-default-secret-value";
  process.env.INTERNAL_JOB_TOKEN = "tok";
  process.env.WEB_ORIGIN = "https://example.com";
  process.env.MOCK_PAYMENTS = "false";
  process.env.MOCK_WHATSAPP = "false";
  process.env.MOCK_AUTH = "false";
  delete process.env.AUTH_ENFORCE;
  process.env.RAZORPAY_KEY_ID = "rzp_test";
  process.env.RAZORPAY_KEY_SECRET = "sec";
  process.env.RAZORPAY_WEBHOOK_SECRET = "wh";
  process.env.WHATSAPP_VERIFY_TOKEN = "v";
  process.env.WHATSAPP_APP_SECRET = "s";
  process.env.WHATSAPP_ACCESS_TOKEN = "a";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "1";
  process.env.ADMIN_MOBILES = "+919900000009";
}

describe("assertProductionConfig", () => {
  const snap = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in snap)) delete process.env[k];
    }
    Object.assign(process.env, snap);
  });

  it("no-ops outside production", () => {
    process.env.NODE_ENV = "development";
    assert.doesNotThrow(() => assertProductionConfig());
  });

  it("passes with full production secrets", () => {
    setProdBase();
    assert.doesNotThrow(() => assertProductionConfig());
  });

  it("fails when production mocks stay on", () => {
    setProdBase();
    process.env.MOCK_PAYMENTS = "true";
    assert.throws(() => assertProductionConfig(), /MOCK_PAYMENTS/);
  });

  it("requires ADMIN_MOBILES at boot, including mock-auth staging", () => {
    setProdBase();
    delete process.env.ADMIN_MOBILES;
    assert.throws(() => assertProductionConfig(), /missing ADMIN_MOBILES/);
    process.env.APP_ENV = "staging";
    process.env.MOCK_AUTH = "true";
    process.env.MOCK_WHATSAPP = "true";
    assert.throws(() => assertProductionConfig(), /missing ADMIN_MOBILES/);
  });

  it("fails when MOCK_WHATSAPP or MOCK_AUTH stay on", () => {
    setProdBase();
    process.env.MOCK_WHATSAPP = "true";
    assert.throws(() => assertProductionConfig(), /MOCK_WHATSAPP/);
    setProdBase();
    process.env.MOCK_AUTH = "true";
    assert.throws(() => assertProductionConfig(), /MOCK_AUTH/);
  });

  it("allows MOCK_AUTH and MOCK_WHATSAPP when APP_ENV=staging", () => {
    setProdBase();
    process.env.APP_ENV = "staging";
    process.env.MOCK_AUTH = "true";
    process.env.MOCK_WHATSAPP = "true";
    assert.doesNotThrow(() => assertProductionConfig());
  });

  it("still requires live payments in staging", () => {
    setProdBase();
    process.env.APP_ENV = "staging";
    process.env.MOCK_AUTH = "true";
    process.env.MOCK_PAYMENTS = "true";
    assert.throws(() => assertProductionConfig(), /MOCK_PAYMENTS/);
  });

  it("fails when AUTH_ENFORCE is false", () => {
    setProdBase();
    process.env.AUTH_ENFORCE = "false";
    assert.throws(() => assertProductionConfig(), /AUTH_ENFORCE/);
  });

  it("fails when AUTH_SECRET is the local default", () => {
    setProdBase();
    process.env.AUTH_SECRET = "localmeals-dev-auth-secret";
    assert.throws(() => assertProductionConfig(), /AUTH_SECRET/);
  });

  it("fails on missing required env", () => {
    setProdBase();
    delete process.env.DATABASE_URL;
    assert.throws(() => assertProductionConfig(), /missing DATABASE_URL/);
    setProdBase();
    process.env.DATABASE_URL = "   ";
    assert.throws(() => assertProductionConfig(), /missing DATABASE_URL/);
    setProdBase();
    delete process.env.INTERNAL_JOB_TOKEN;
    assert.throws(() => assertProductionConfig(), /missing INTERNAL_JOB_TOKEN/);
    setProdBase();
    delete process.env.WEB_ORIGIN;
    assert.throws(() => assertProductionConfig(), /missing WEB_ORIGIN/);
  });

  it("requires Razorpay keys when payments are live", () => {
    setProdBase();
    delete process.env.RAZORPAY_KEY_ID;
    assert.throws(() => assertProductionConfig(), /RAZORPAY_KEY_ID/);
  });

  it("requires WhatsApp keys when WA is live", () => {
    setProdBase();
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    assert.throws(() => assertProductionConfig(), /WHATSAPP_ACCESS_TOKEN/);
  });
});
