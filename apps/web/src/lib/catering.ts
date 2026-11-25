import type { MsgKey } from "@localmeals/i18n";
import type { FulfillmentMode } from "@/lib/fulfillment";

export type CateringStatus = "AWAITING_ADVANCE" | "ADVANCE_PAID" | "PAID" | "COMPLETED" | "CANCELLED";

export type CateringCombo = {
  id: number;
  name: string;
  nameTa: string | null;
  contents: string | null;
  pricePerPlatePaise: number;
  minPlates: number;
  maxPlates: number;
  isVeg: boolean;
  imageUrl: string | null;
  isActive: boolean;
};

export type CateringBooking = {
  publicId: string;
  status: CateringStatus;
  kitchenSlug: string;
  kitchenName: string;
  comboName: string;
  comboContents: string | null;
  plates: number;
  pricePerPlatePaise: number;
  foodPaise: number;
  platformFeePaise: number;
  totalPaise: number;
  advancePaise: number;
  balancePaise: number;
  paidPaise: number;
  refundedPaise: number;
  eventDate: string;
  eventTime: string;
  cutoffAt: string;
  fulfillmentMode: FulfillmentMode;
  note: string | null;
  duePhase: "ADVANCE" | "BALANCE" | null;
  duePaise: number;
  paymentUrl: string | null;
  canCustomerCancel: boolean;
  deliveryAddress: string | null;
  pickupLandmark: string | null;
  customerMobile: string | null;
  cancelReason: string | null;
};

export function cateringStatusKey(status: CateringStatus): MsgKey {
  return `cat.status.${status}` as MsgKey;
}

export const cateringBookingHref = (publicId: string) => `/catering/bookings/${publicId}`;
