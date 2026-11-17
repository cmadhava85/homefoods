export type OnboardingStatus =
  | "DRAFT"
  | "DOCS_SUBMITTED"
  | "GATEWAY_KYC_PENDING"
  | "LIVE"
  | "REJECTED";

export type CookGateInput = {
  onboardingStatus: OnboardingStatus;
  fssaiNumber: string | null;
  isActive: boolean;
  /** Preferred while Razorpay Route is blocked (RBI). */
  payoutUpiId?: string | null;
  /** Bank / IFSC / payee note for manual NEFT. */
  payoutAccountNote?: string | null;
  /** Optional Route linked account (`acc_…`) when available. */
  payoutBeneficiaryRef?: string | null;
};

/** At least one payout path: UPI, bank note, or Route. */
export function hasCookPayoutDetails(cook: CookGateInput): boolean {
  return Boolean(
    cook.payoutUpiId?.trim() ||
      cook.payoutAccountNote?.trim() ||
      cook.payoutBeneficiaryRef?.trim(),
  );
}

export function canAcceptPaidOrders(cook: CookGateInput): boolean {
  return (
    cook.onboardingStatus === "LIVE" &&
    Boolean(cook.fssaiNumber?.trim()) &&
    cook.isActive &&
    hasCookPayoutDetails(cook)
  );
}

export function assertCanAcceptPaidOrders(cook: CookGateInput): void {
  if (!canAcceptPaidOrders(cook)) {
    throw new Error(
      "This kitchen isn’t ready to take paid orders yet — it needs LIVE status, FSSAI, and payout details",
    );
  }
}
