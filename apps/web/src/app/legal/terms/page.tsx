import type { Metadata } from "next";
import Link from "next/link";
import { GATEWAY_FEE_BPS, WEEK_DISCOUNT_PERCENT_MAX } from "@localmeals/domain";
import { legal } from "@/lib/legal";

export const metadata: Metadata = { title: "Terms of service" };

export default function TermsPage() {
  return (
    <>
      <h1>Terms of service</h1>
      <p>
        These terms govern your use of LocalMeals (the website and WhatsApp ordering service) operated by{" "}
        {legal.entityName}, {legal.address} (&quot;LocalMeals&quot;, &quot;we&quot;). By placing an order you agree
        to them.
      </p>

      <h2>1. What LocalMeals is</h2>
      <p>
        LocalMeals is a marketplace. Independent home kitchens (&quot;cooks&quot;) list, prepare, pack and — unless a
        delivery partner is shown — deliver meals. Each cook is the seller of the food and is responsible for its
        preparation, hygiene, ingredients, allergen information and their FSSAI registration, which is shown on the
        kitchen page. LocalMeals provides the ordering, payment collection, notifications and support.
      </p>

      <h2>2. Accounts</h2>
      <ul>
        <li>You sign in with an Indian mobile number verified by a one-time password sent on WhatsApp.</li>
        <li>You must be 18 or older, or order with a parent&apos;s or guardian&apos;s consent (Family / Child Pays).</li>
        <li>Keep access to your number secure; orders placed from your verified session are treated as yours.</li>
        <li>
          You can delete your account at any time from <Link href="/account">Account</Link> — see the{" "}
          <Link href="/legal/privacy">Privacy policy</Link>.
        </li>
      </ul>

      <h2>3. Orders, cut-off and prices</h2>
      <ul>
        <li>
          Each kitchen sets a cut-off time for each meal (Asia/Kolkata time). Orders close at cut-off; any later
          request is at the cook&apos;s discretion.
        </li>
        <li>
          An order is confirmed only after payment succeeds. Unpaid orders are released automatically after the
          payment window shown at checkout.
        </li>
        <li>
          Prices are set by the cook and shown inclusive of applicable taxes. A platform fee per checkout may
          apply; the current amount is shown before you pay. Week-plan discounts (up
          to {WEEK_DISCOUNT_PERCENT_MAX}%) are set by each cook.
        </li>
        <li>
          When enabled, a convenience fee covering payment processing (about {GATEWAY_FEE_BPS.LINK / 100}% for
          UPI/card/netbanking links, {GATEWAY_FEE_BPS.UPI_QR / 100}% for UPI QR at pickup) is shown separately before
          you pay. It is refunded together with the order.
        </li>
        <li>
          LocalMeals credit (from refunds you choose to take as credit) is applied automatically at checkout, has no
          cash value outside LocalMeals, and can be refunded to your bank on request via support.
        </li>
        <li>Quantities are limited by each kitchen&apos;s daily capacity.</li>
      </ul>

      <h2>4. Payments</h2>
      <p>
        Payments are processed by Razorpay (UPI, cards, net-banking). LocalMeals never sees or stores your card or
        UPI PIN. Cancellations and refunds follow the{" "}
        <Link href="/legal/refunds">Cancellation &amp; refund policy</Link>.
      </p>

      <h2>5. Food safety and allergies</h2>
      <p>
        Home kitchens may handle common allergens (milk, nuts, gluten, sesame, etc.). If you have an allergy,
        message the cook before ordering. Report any food-safety concern from My orders or to the grievance
        officer — we may pause a kitchen while we investigate.
      </p>

      <h2>6. Reviews and conduct</h2>
      <p>
        Reviews must be honest and about your own order. Do not post abusive, unlawful or personal information. We
        may remove content or suspend accounts that misuse the service, place fraudulent orders or abuse cooks or
        riders.
      </p>

      <h2>7. Liability</h2>
      <p>
        To the extent permitted by law, LocalMeals&apos; liability for any order is limited to the amount you paid
        for that order. Nothing in these terms limits your rights under the Consumer Protection Act, 2019.
      </p>

      <h2>8. Disputes and governing law</h2>
      <p>
        Contact us first via <Link href="/legal/contact">Contact &amp; grievances</Link>. These terms are governed by
        the laws of India; courts at Chennai, Tamil Nadu have jurisdiction.
      </p>

      <h2>9. Changes</h2>
      <p>We may update these terms; the effective date below changes when we do. Material changes are notified on WhatsApp.</p>
    </>
  );
}
