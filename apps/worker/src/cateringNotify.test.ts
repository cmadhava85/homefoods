import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cateringWaMessages } from "./cateringNotify.js";

const base = {
  publicId: "CAT-AB12CD34EF",
  customerMobile: "+919800000101",
  cookMobile: "+919800000102",
  kitchenName: "CSK",
  comboName: "Seemantham Feast",
  plates: 30,
  eventDate: "2031-01-10",
  eventTime: "12:00",
  fulfillmentMode: "DELIVERY",
  balancePaise: 300_000,
  totalPaise: 600_700,
  bookingUrl: "https://web/catering/bookings/CAT-AB12CD34EF",
};

describe("catering WhatsApp copy", () => {
  it("advance paid tells the customer the balance + link and the cook the new order", () => {
    const [customer, cook] = cateringWaMessages("CateringAdvancePaid", base);
    assert.equal(customer.to, base.customerMobile);
    assert.match(customer.body, /Party order booked · CSK[\s\S]*30× Seemantham Feast[\s\S]*Balance ₹3000[\s\S]*https:\/\/web\/catering/);
    assert.equal(cook.to, base.cookMobile);
    assert.match(cook.body, /New party order · CAT-AB12CD34EF[\s\S]*Cook delivers/);
  });

  it("cancel copy depends on whether money was taken", () => {
    const [refunded] = cateringWaMessages("CateringCancelled", { ...base, refundPaise: 300_350, cancelledBy: "COOK" });
    assert.match(refunded.body, /Refund of ₹3003\.50 initiated/);
    const [free, cook] = cateringWaMessages("CateringCancelled", { ...base, refundPaise: 0, cancelledBy: "CUSTOMER" });
    assert.match(free.body, /No payment was taken/);
    assert.match(cook.body, /Cancelled by customer/);
  });

  it("balance reminder goes only to the customer; unknown events and missing mobiles send nothing", () => {
    const msgs = cateringWaMessages("CateringBalanceDue", base);
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].body, /Balance due[\s\S]*Pay here: https:\/\/web/);
    assert.deepEqual(cateringWaMessages("CateringSomethingElse", base), []);
    assert.equal(cateringWaMessages("CateringBalancePaid", { ...base, cookMobile: null }).length, 1);
  });
});
