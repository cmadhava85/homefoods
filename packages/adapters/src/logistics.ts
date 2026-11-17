/**
 * Partner logistics (Shadowfax / Porter / etc.) — MVP-2.
 * SELF cook delivery remains default until Admin enables partner_delivery
 * and cook.deliveryType = PARTNER.
 */

export type PartnerShipmentInput = {
  orderPublicId: string;
  pickupAddress: string;
  dropAddress: string;
  customerMobile: string;
  cookMobile: string;
  notes?: string;
};

export type PartnerShipmentResult = {
  partnerShipmentId: string;
  trackingUrl?: string | null;
  status: "CREATED" | "ASSIGNED" | "PICKED_UP" | "DELIVERED" | "FAILED";
};

export interface LogisticsProvider {
  readonly name: string;
  createShipment(input: PartnerShipmentInput): Promise<PartnerShipmentResult>;
  getShipment(partnerShipmentId: string): Promise<PartnerShipmentResult>;
  /** Optional: cancel open shipment (best-effort). */
  cancelShipment?(partnerShipmentId: string): Promise<void>;
}

/** Stub — throws until a real partner adapter is enabled. */
export class UnconfiguredLogisticsProvider implements LogisticsProvider {
  readonly name = "unconfigured";

  async createShipment(): Promise<PartnerShipmentResult> {
    throw new Error(
      "Partner delivery is not configured — use SELF cook delivery or MOCK_LOGISTICS=true.",
    );
  }

  async getShipment(): Promise<PartnerShipmentResult> {
    throw new Error("Partner delivery is not configured");
  }
}

/** Local / staging stand-in until Shadowfax (or similar) is contracted. */
export class MockLogisticsProvider implements LogisticsProvider {
  readonly name = "mock";
  private readonly store = new Map<string, PartnerShipmentResult>();

  async createShipment(input: PartnerShipmentInput): Promise<PartnerShipmentResult> {
    const partnerShipmentId = `shp_mock_${input.orderPublicId.slice(0, 12)}_${Date.now().toString(36)}`;
    const row: PartnerShipmentResult = {
      partnerShipmentId,
      trackingUrl: `https://localmeals.local/track/${partnerShipmentId}`,
      status: "CREATED",
    };
    this.store.set(partnerShipmentId, row);
    return row;
  }

  async getShipment(partnerShipmentId: string): Promise<PartnerShipmentResult> {
    const row = this.store.get(partnerShipmentId);
    if (!row) {
      return {
        partnerShipmentId,
        trackingUrl: null,
        status: "ASSIGNED",
      };
    }
    return row;
  }

  async cancelShipment(partnerShipmentId: string): Promise<void> {
    this.store.delete(partnerShipmentId);
  }

  /** Test helper: advance mock shipment status. */
  setStatus(partnerShipmentId: string, status: PartnerShipmentResult["status"]) {
    const row = this.store.get(partnerShipmentId);
    if (row) this.store.set(partnerShipmentId, { ...row, status });
  }
}

function mockLogisticsEnabled() {
  if (process.env.MOCK_LOGISTICS === "false") return false;
  if (process.env.MOCK_LOGISTICS === "true") return true;
  // Default: mock outside production so local/staging can exercise the path.
  return process.env.NODE_ENV !== "production";
}

let logisticsProvider: LogisticsProvider = mockLogisticsEnabled()
  ? new MockLogisticsProvider()
  : new UnconfiguredLogisticsProvider();

export function getLogisticsProvider(): LogisticsProvider {
  return logisticsProvider;
}

export function setLogisticsProvider(provider: LogisticsProvider) {
  logisticsProvider = provider;
}

export function resetLogisticsProvider() {
  logisticsProvider = mockLogisticsEnabled()
    ? new MockLogisticsProvider()
    : new UnconfiguredLogisticsProvider();
}

export function isMockLogistics() {
  return getLogisticsProvider().name === "mock";
}
