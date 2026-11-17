import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { closeDb, cookProfiles, createDb } from "@localmeals/db";
import { eq } from "drizzle-orm";
import { loginCustomer, testMobile } from "./testHelpers.js";

process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

describe("cook enrollment", () => {
  const db = createDb();
  const app = buildApp(db);
  // Exactly +91 + 10 digits (testMobile prefixes can overrun length)
  const mobile = `+9198${String(Date.now()).slice(-8)}`;
  let cookId = "";

  before(async () => {
    await app.ready();
  });

  after(async () => {
    if (cookId) {
      await db.delete(cookProfiles).where(eq(cookProfiles.id, cookId));
    }
    await app.close();
    await closeDb(db);
  });

  it("rejects apply without payout", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cooks/apply",
      payload: {
        mobile,
        kitchenName: "Test Kitchen",
        pinCode: "600119",
        acceptedKitchenStandards: true,
      },
    });
    assert.ok(res.statusCode >= 400);
  });

  it("rejects apply without standards acceptance", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cooks/apply",
      payload: {
        mobile: `+9197${String(Date.now()).slice(-8)}`,
        kitchenName: "No Accept Kitchen",
        pinCode: "600119",
        payoutUpiId: "x@upi",
      },
    });
    assert.ok(res.statusCode >= 400);
  });

  it("creates DRAFT when FSSAI omitted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cooks/apply",
      payload: {
        mobile,
        kitchenName: "Smoke Enroll Kitchen",
        pinCode: "600119",
        payoutUpiId: "enroll@upi",
        acceptedKitchenStandards: true,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().ok, true);
    assert.equal(res.json().onboardingStatus, "DRAFT");
    const row = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.mobileNumber, mobile),
    });
    assert.ok(row);
    cookId = row!.id;
    assert.equal(row!.isActive, false);
    assert.equal(row!.fssaiNumber, null);
  });

  it("admin approve LIVE requires FSSAI first", async () => {
    const adminMobile = "+919900000001";
    const otp = await app.inject({
      method: "POST",
      url: "/auth/otp/request",
      payload: { mobile: adminMobile, role: "ADMIN" },
    });
    const code = otp.json().mockCode ?? "123456";
    const ver = await app.inject({
      method: "POST",
      url: "/auth/otp/verify",
      payload: { mobile: adminMobile, role: "ADMIN", code },
    });
    const headers = { authorization: `Bearer ${ver.json().token}` };

    const blocked = await app.inject({
      method: "POST",
      url: `/admin/cooks/${cookId}/approve`,
      headers,
      payload: {},
    });
    assert.ok(blocked.statusCode >= 400, blocked.body);

    await db
      .update(cookProfiles)
      .set({ fssaiNumber: "12345678901234", onboardingStatus: "DOCS_SUBMITTED" })
      .where(eq(cookProfiles.id, cookId));

    const res = await app.inject({
      method: "POST",
      url: `/admin/cooks/${cookId}/approve`,
      headers,
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().onboardingStatus, "LIVE");
    assert.equal(res.json().isActive, true);
  });

  it("duplicate mobile is rejected", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/cooks/apply",
      payload: {
        mobile,
        kitchenName: "Another Name",
        pinCode: "600119",
        fssaiNumber: "12345678901234",
        payoutUpiId: "x@upi",
        acceptedKitchenStandards: true,
      },
    });
    assert.ok(res.statusCode >= 400);
  });

  it("customer session not required for apply", async () => {
    const { mobile: cust } = await loginCustomer(app, testMobile("82"));
    assert.ok(cust);
  });
});
