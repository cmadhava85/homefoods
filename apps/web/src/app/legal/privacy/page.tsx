import type { Metadata } from "next";
import Link from "next/link";
import { legal } from "@/lib/legal";

export const metadata: Metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy policy</h1>
      <p>
        {legal.entityName} (&quot;we&quot;) is the Data Fiduciary for personal data processed through LocalMeals.
        This notice is given under the Digital Personal Data Protection Act, 2023 (DPDP Act).
      </p>

      <h2>1. Data we collect and why</h2>
      <table className="legal-table">
        <thead>
          <tr>
            <th>Data</th>
            <th>Purpose</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Mobile number</td>
            <td>Sign-in (OTP), order updates on WhatsApp, support</td>
          </tr>
          <tr>
            <td>Name, delivery addresses, PIN code, optional map pin</td>
            <td>Showing nearby kitchens, delivering your order</td>
          </tr>
          <tr>
            <td>Orders, payments status, refunds, reviews</td>
            <td>Fulfilling orders, refunds, tax/accounting records, kitchen ratings</td>
          </tr>
          <tr>
            <td>WhatsApp messages you send to our number</td>
            <td>Taking orders and answering you on WhatsApp</td>
          </tr>
          <tr>
            <td>Technical logs (IP address, device/browser, request ids)</td>
            <td>Security, fraud and abuse prevention, debugging</td>
          </tr>
        </tbody>
      </table>
      <p>
        We do not collect card numbers or UPI PINs — Razorpay handles payments. We do not sell personal data or use
        it for third-party advertising.
      </p>

      <h2>2. Who we share it with</h2>
      <ul>
        <li>The cook you order from: your name, phone and delivery address/landmark for that order.</li>
        <li>Delivery partners (only when the order uses one): name, phone, address.</li>
        <li>Razorpay (payments and refunds), Meta WhatsApp Business (messaging), Google Cloud (hosting in Mumbai, India).</li>
        <li>Authorities, when required by law.</li>
      </ul>

      <h2>3. How long we keep it</h2>
      <ul>
        <li>Profile and saved addresses: until you delete your account.</li>
        <li>
          Order, payment and invoice records: as required by tax law (currently up to 8 years); after account
          deletion these are kept without your name, phone or address.
        </li>
        <li>Sign-in codes: minutes. Security logs: up to 90 days.</li>
      </ul>

      <h2>4. Your rights</h2>
      <ul>
        <li>
          <strong>Access and correction:</strong> view and edit your name and addresses in{" "}
          <Link href="/account">Account</Link>; see your orders in <Link href="/orders">My orders</Link>.
        </li>
        <li>
          <strong>Erasure:</strong> <Link href="/account">Account → Delete my account</Link> removes your profile,
          addresses, follows and family links immediately and anonymises past orders. Orders still in progress must
          finish or be cancelled first.
        </li>
        <li>
          <strong>Withdraw consent:</strong> turn off WhatsApp alerts by replying STOP, or delete your account.
        </li>
        <li>
          <strong>Grievances and nomination:</strong> contact our Grievance Officer (below). If unresolved, you may
          complain to the Data Protection Board of India.
        </li>
      </ul>

      <h2>5. Security</h2>
      <p>
        Data is encrypted in transit (TLS) and at rest, access is role-restricted and logged, and sign-in codes are
        stored only as hashes.
      </p>

      <h2>6. Children</h2>
      <p>
        Accounts are for adults. Under-18s may be fed through Family / Child Pays where a parent or guardian approves
        and pays.
      </p>

      <h2>7. Contact</h2>
      <p>
        Grievance Officer: {legal.grievanceName}, {legal.grievanceEmail}. More on{" "}
        <Link href="/legal/contact">Contact &amp; grievances</Link>.
      </p>
    </>
  );
}
