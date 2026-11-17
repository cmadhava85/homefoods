import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { isExternalPaymentUrl, payPageHref } from "@/lib/payments";
import {
  ConfirmedCheckoutClient,
  ConfirmedOrderClient,
  type ConfirmedCheckoutView,
  type ConfirmedOrderView,
} from "./ConfirmedClient";

export default async function ConfirmedPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const isCheckout = publicId.startsWith("CHK-");

  if (isCheckout) {
    const checkout = await api<ConfirmedCheckoutView>(`/checkouts/${publicId}`);

    if (checkout.status === "AWAITING_PAYMENT" || checkout.status === "CONFIRMING_PAYMENT") {
      if (isExternalPaymentUrl(checkout.paymentUrl)) {
        redirect(checkout.paymentUrl!);
      }
      redirect(payPageHref(publicId, checkout.gatewayTxnId));
    }

    return <ConfirmedCheckoutClient checkout={checkout} />;
  }

  const order = await api<ConfirmedOrderView>(`/orders/${publicId}`);

  if (order.status === "AWAITING_PAYMENT" || order.status === "CONFIRMING_PAYMENT") {
    if (isExternalPaymentUrl(order.paymentUrl)) {
      redirect(order.paymentUrl!);
    }
    redirect(payPageHref(publicId, order.gatewayTxnId));
  }

  return <ConfirmedOrderClient order={order} />;
}
