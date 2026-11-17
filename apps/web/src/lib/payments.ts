/** Live Razorpay short URLs — not our local mock pay page. */
export function isExternalPaymentUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.hostname.includes("rzp.io") || u.hostname.includes("razorpay.com");
  } catch {
    return false;
  }
}

export function payPageHref(id: string, gatewayTxnId?: string | null): string {
  return `/pay/${id}${gatewayTxnId ? `?txn=${gatewayTxnId}` : ""}`;
}
