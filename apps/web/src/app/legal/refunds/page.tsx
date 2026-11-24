import type { Metadata } from "next";
import Link from "next/link";
import { LATE_ORDER_CLOSE_HOURS_BEFORE_DELIVERY } from "@localmeals/domain";

export const metadata: Metadata = { title: "Cancellation & refunds" };

export default function RefundsPage() {
  return (
    <>
      <h1>Cancellation &amp; refund policy</h1>

      <h2>Cancelling an order</h2>
      <table className="legal-table">
        <thead>
          <tr>
            <th>When</th>
            <th>What happens</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Not yet paid</td>
            <td>Cancel any time; nothing is charged. Unpaid orders also expire on their own.</td>
          </tr>
          <tr>
            <td>Paid, before the kitchen&apos;s cut-off</td>
            <td>Cancel from My orders or on WhatsApp — full refund, including the platform fee.</td>
          </tr>
          <tr>
            <td>Paid, after cut-off</td>
            <td>
              Send a cancel request. The cook has already planned your meal: if they accept you get a full refund; if
              they decline, the order stands.
            </td>
          </tr>
          <tr>
            <td>Late request (after cut-off)</td>
            <td>
              Closes {LATE_ORDER_CLOSE_HOURS_BEFORE_DELIVERY} hours before delivery. If the cook declines a paid late
              request it is refunded in full.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>When we refund automatically</h2>
      <ul>
        <li>The cook cancels, closes for the day, or runs out of capacity after you paid.</li>
        <li>A payment arrives after the order was already released or cancelled.</li>
        <li>The order could not be delivered because of the kitchen or our delivery partner.</li>
      </ul>
      <p>
        On a multi-day (week) plan, cancelling one day refunds that day; any week discount and the platform fee are
        rebalanced across the remaining days so you are never charged more than the days you keep.
      </p>

      <h2>Problems with your food</h2>
      <p>
        Wrong, missing, spoiled or unsafe food: report it from My orders within 24 hours of delivery, with a
        photo if possible. Depending on the issue we refund fully or partly, or arrange a replacement.
      </p>

      <h2>How and when refunds arrive</h2>
      <p>
        <strong>Instant credit (optional):</strong> when you cancel a paid order you can take the refund as LocalMeals
        credit. It is added immediately and used first on your next order. Any part of an order you paid with credit
        always comes back as credit. You can ask support to move unused credit to your bank at any time.
      </p>
      <p>
        Refunds go back to the original payment method via Razorpay. UPI refunds usually arrive within 1–3 working
        days; cards and net-banking can take 5–7 working days, depending on your bank. You get a WhatsApp message when
        we start the refund.
      </p>

      <p>
        Questions: <Link href="/legal/contact">Contact &amp; grievances</Link>.
      </p>
    </>
  );
}
