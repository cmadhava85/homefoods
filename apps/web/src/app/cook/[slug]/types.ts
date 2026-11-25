export type CookEarnings = {
  serviceDate: string;
  note: string;
  /** Current commission for new orders (basis points). */
  commissionBps?: number;
  meal: { mealType: string; plates: number; foodPaise: number };
  day: {
    plates: number;
    foodPaise: number;
    deliveredPlates: number;
    deliveredFoodPaise: number;
    heldPlates: number;
    /** Commission on today's plates, from each order's snapshot rate. */
    commissionPaise?: number;
    pendingClawbackPaise?: number;
    clawbackPaise?: number;
  };
  payout: {
    status: string;
    label: string;
    detail: string | null;
    netPaise: number | null;
    feesPaise?: number;
    orderCount: number | null;
    manualPaidAt: string | null;
    manualUtr: string | null;
    settlementStatus: string | null;
    clawbackPaise?: number;
  };
};

export type Manifest = {
  cook: { kitchenName: string; id: string; mobileNumber?: string; deliveryType?: string };
  lunchCutoff?: string;
  deliveryWindow?: string;
  deliveryWindowParts?: {
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
  };
  delivery?: {
    type: "SELF" | "PARTNER";
    platformPartnerEnabled: boolean;
    partnerActive: boolean;
  };
  whatsapp?: { cookMobile: string; note: string };
  lock: { headcount: number; routeMapsUrl: string | null } | null;
  earnings?: CookEarnings;
  orders: Array<{
    id: number;
    publicId: string;
    itemName: string;
    qty: number;
    spice: string;
    status: string;
    customerMobile: string;
    deliveryTargetAddress: string;
    fulfillmentMode?: string | null;
    logisticsMode?: string | null;
    partnerShipmentId?: string | null;
    partnerTrackingUrl?: string | null;
    routeMapsUrl?: string | null;
  }>;
};

export type WaFeedItem = {
  id: number;
  eventName: string;
  preview: string;
  to: string;
  processedAt: string | null;
  createdAt: string;
};

export type DeskReview = {
  id: number;
  rating: number;
  comment: string | null;
  cookReply: string | null;
  createdAt: string;
  customerLabel: string;
  orderPublicId: string;
  itemName: string;
  serviceDate: string;
};

export type MenuItem = {
  id: number;
  itemName: string;
  itemNameTa?: string | null;
  pricePaise: number;
  isVeg: boolean;
  portionNote?: string | null;
  isAvailable: boolean;
  allergens: string[];
  serviceDate: string | null;
  dayOfWeek: number | null;
  imageUrl: string | null;
  totalStockAvailable: number;
};

export type MealType = "BREAKFAST" | "LUNCH" | "DINNER";
