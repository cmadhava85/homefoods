import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeConcernPhotoUrl,
  orderAudience,
  redactOrderForAudience,
} from "./orderViews.js";
import type { SessionUser } from "../services/auth.js";

const order = {
  id: 1,
  publicId: "LM-ABC",
  status: "AWAITING_PAYMENT",
  customerMobile: "+919111111111",
  payerMobile: "+919222222222",
  deliveryTargetAddress: "Tower 1",
  cookId: "cook-1",
  foodPaise: 10000,
  qty: 1,
  deliveryPaise: 0,
  platformFeePaise: 700,
  fulfillmentMode: "PICKUP",
  itemName: "Sambar",
};

describe("orderAudience", () => {
  it("is public without a session", () => {
    assert.equal(orderAudience(null, order, "csk-homemade-delights"), "public");
  });

  it("is owner for matching customer", () => {
    const user: SessionUser = {
      mobile: "+919111111111",
      role: "CUSTOMER",
      fullName: "A",
    };
    assert.equal(orderAudience(user, order, "csk-homemade-delights"), "owner");
  });

  it("is owner for matching payer", () => {
    const user: SessionUser = {
      mobile: "+919222222222",
      role: "CUSTOMER",
      fullName: "Payer",
    };
    assert.equal(orderAudience(user, order, "csk-homemade-delights"), "owner");
  });

  it("is staff for matching cook", () => {
    const user: SessionUser = {
      mobile: "+919876543210",
      role: "COOK",
      fullName: "Cook",
      cookSlug: "csk-homemade-delights",
    };
    assert.equal(orderAudience(user, order, "csk-homemade-delights"), "staff");
  });

  it("is staff for admin", () => {
    const user: SessionUser = {
      mobile: "+919000000000",
      role: "ADMIN",
      fullName: "Admin",
    };
    assert.equal(orderAudience(user, order, "csk-homemade-delights"), "staff");
  });

  it("is public for wrong cook or unrelated customer", () => {
    const cook: SessionUser = {
      mobile: "+919876543210",
      role: "COOK",
      fullName: "Cook",
      cookSlug: "other-kitchen",
    };
    assert.equal(orderAudience(cook, order, "csk-homemade-delights"), "public");
    const customer: SessionUser = {
      mobile: "+919333333333",
      role: "CUSTOMER",
      fullName: "X",
    };
    assert.equal(orderAudience(customer, order, "csk-homemade-delights"), "public");
    assert.equal(orderAudience(cook, order, null), "public");
  });
});

describe("redactOrderForAudience", () => {
  it("strips mobiles and address for public audience", () => {
    const view = redactOrderForAudience(order, "public", {
      kitchenName: "K",
      pickup: { landmark: "Gate" },
    });
    assert.equal(view.customerMobile, undefined);
    assert.equal(view.payerMobile, undefined);
    assert.equal(view.publicId, "LM-ABC");
    assert.equal(view.kitchenName, "K");
    assert.equal(view.deliveryTargetAddress, undefined);
    assert.equal(view.hasDeliveryAddress, true);
    assert.equal(view.itemName, "Sambar");
    assert.equal(view.fulfillmentMode, "PICKUP");
    assert.equal(view.pickup, null);
  });

  it("keeps mobiles for owner and staff", () => {
    const owner = redactOrderForAudience(order, "owner");
    assert.equal(owner.customerMobile, "+919111111111");
    assert.equal(owner.payerMobile, "+919222222222");
    const staff = redactOrderForAudience(order, "staff", { pickup: { code: "1" } });
    assert.equal(staff.customerMobile, "+919111111111");
    assert.deepEqual(staff.pickup, { code: "1" });
  });
});

describe("assertSafeConcernPhotoUrl", () => {
  it("allows concern uploads path", () => {
    assert.equal(assertSafeConcernPhotoUrl("/uploads/concern-abc.jpg"), "/uploads/concern-abc.jpg");
  });

  it("returns null for empty", () => {
    assert.equal(assertSafeConcernPhotoUrl(null), null);
    assert.equal(assertSafeConcernPhotoUrl(""), null);
    assert.equal(assertSafeConcernPhotoUrl(undefined), null);
  });

  it("rejects external urls", () => {
    assert.throws(() => assertSafeConcernPhotoUrl("https://evil.example/x.png"), /Invalid concern photo/);
    assert.throws(() => assertSafeConcernPhotoUrl("/uploads/menu-abc.jpg"), /Invalid concern photo/);
  });

  it("rejects path traversal and overlong", () => {
    assert.throws(() => assertSafeConcernPhotoUrl("/uploads/concern-../secret"), /Invalid concern photo/);
    assert.throws(() => assertSafeConcernPhotoUrl("/uploads/concern-a//b"), /Invalid concern photo/);
    assert.throws(
      () => assertSafeConcernPhotoUrl(`/uploads/concern-${"x".repeat(200)}.jpg`),
      /Invalid concern photo/,
    );
  });
});
