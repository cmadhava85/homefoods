import type { Metadata } from "next";
import { FREE_SELF_DELIVERY_KM, MAX_SELF_DELIVERY_KM } from "@localmeals/domain";

export const metadata: Metadata = { title: "Delivery policy" };

export default function DeliveryPage() {
  return (
    <>
      <h1>Delivery &amp; pickup policy</h1>
      <ul>
        <li>We serve selected PIN codes in Chennai, Tamil Nadu. Kitchens shown to you are the ones that serve your area.</li>
        <li>
          Meals are cooked fresh for a scheduled delivery window (for example, lunch) shown on the kitchen page and in
          your confirmation. We do not offer on-demand delivery.
        </li>
        <li>
          Cooks deliver themselves within about {MAX_SELF_DELIVERY_KM} km; delivery within {FREE_SELF_DELIVERY_KM} km
          is free. Any delivery charge is shown before you pay. Some orders may use a delivery partner — you&apos;ll
          get a tracking link.
        </li>
        <li>
          <strong>Pickup:</strong> where offered, collect from the kitchen&apos;s pickup landmark during the window.
          The exact landmark is shared after payment.
        </li>
        <li>
          Please be reachable on your phone during the window. If delivery fails because no one is available, a refund
          is at the cook&apos;s discretion.
        </li>
        <li>
          If the cook is late or cannot deliver, you&apos;ll be told on WhatsApp; undelivered orders are refunded per
          the Cancellation &amp; refund policy.
        </li>
        <li>We do not ship outside India.</li>
      </ul>
    </>
  );
}
