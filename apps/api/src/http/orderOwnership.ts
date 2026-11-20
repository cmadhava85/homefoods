/** Shared ownership checks for HTTP + WhatsApp order/checkout actions. */

export type OrderOwnerFields = {
  customerMobile: string;
  payerMobile?: string | null;
};

export function mobileOwnsOrder(order: OrderOwnerFields, mobile: string): boolean {
  return (
    order.customerMobile === mobile ||
    (order.payerMobile != null && order.payerMobile === mobile)
  );
}

/** Customer or family payer may cancel / pay / raise concern. */
export function assertCustomerOwnsOrder(order: OrderOwnerFields, mobile: string): void {
  if (!mobileOwnsOrder(order, mobile)) {
    throw new Error("Not your order");
  }
}

export function assertCustomerOwnsCheckout(
  seed: OrderOwnerFields | null | undefined,
  mobile: string,
): void {
  if (!seed) throw new Error("Checkout not found");
  assertCustomerOwnsOrder(seed, mobile);
}
