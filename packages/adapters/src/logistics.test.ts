import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  MockLogisticsProvider,
  setLogisticsProvider,
  getLogisticsProvider,
  resetLogisticsProvider,
} from "./logistics.js";

describe("mock logistics provider", () => {
  beforeEach(() => {
    setLogisticsProvider(new MockLogisticsProvider());
  });

  it("creates a shipment id and tracking url", async () => {
    const logistics = getLogisticsProvider();
    const created = await logistics.createShipment({
      orderPublicId: "LM-TEST123",
      pickupAddress: "Kitchen",
      dropAddress: "Tower 1",
      customerMobile: "+919840111111",
      cookMobile: "+919840222222",
    });
    assert.match(created.partnerShipmentId, /^shp_mock_/);
    assert.equal(created.status, "CREATED");
    assert.ok(created.trackingUrl);

    const got = await logistics.getShipment(created.partnerShipmentId);
    assert.equal(got.partnerShipmentId, created.partnerShipmentId);
  });

  it("reset restores default provider", () => {
    resetLogisticsProvider();
    assert.ok(["mock", "unconfigured"].includes(getLogisticsProvider().name));
  });
});
