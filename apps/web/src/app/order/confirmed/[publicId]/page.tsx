import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { isExternalPaymentUrl, payPageHref } from "@/lib/payments";
import {
  ConfirmedCheckoutClient,
  ConfirmedOrderClient,
  type ConfirmedCheckoutView,
  type ConfirmedOrderView,
} from "./ConfirmedClient";

function shouldRedirectToPay(view: {
  status: string;
  awaitingFamilyPay?: boolean | null;
  paymentUrl?: string;
  gatewayTxnId?: string | null;
}): boolean {
  const pending =
    view.status === "AWAITING_PAYMENT" || view.status === "CONFIRMING_PAYMENT";
  if (!pending) return false;
  // Child Pays: senior waits on confirmed; payer/open links still go to UPI.
  if (view.awaitingFamilyPay) return false;
  return true;
}

export default async function ConfirmedPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const isCheckout = publicId.startsWith("CHK-");

  if (isCheckout) {
    const checkout = await api<
      ConfirmedCheckoutView & { awaitingFamilyPay?: boolean }
    >(`/checkouts/${publicId}`);

    if (shouldRedirectToPay(checkout)) {
      if (isExternalPaymentUrl(checkout.paymentUrl)) {
        redirect(checkout.paymentUrl!);
      }
      redirect(payPageHref(publicId, checkout.gatewayTxnId));
    }

    return <ConfirmedCheckoutClient checkout={checkout} />;
  }

  const order = await api<ConfirmedOrderView & { awaitingFamilyPay?: boolean }>(
    `/orders/${publicId}`,
  );

  if (shouldRedirectToPay(order)) {
    if (isExternalPaymentUrl(order.paymentUrl)) {
      redirect(order.paymentUrl!);
    }
    redirect(payPageHref(publicId, order.gatewayTxnId));
  }

  return <ConfirmedOrderClient order={order} />;
}
