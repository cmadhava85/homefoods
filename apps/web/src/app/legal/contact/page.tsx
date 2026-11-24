import type { Metadata } from "next";
import { legal } from "@/lib/legal";

export const metadata: Metadata = { title: "Contact & grievances" };

export default function ContactPage() {
  return (
    <>
      <h1>Contact &amp; grievances</h1>

      <h2>Support</h2>
      <ul>
        <li>WhatsApp / phone: {legal.supportPhone}</li>
        <li>Email: {legal.supportEmail}</li>
        <li>For an order, include its order ID (for example LM-…).</li>
      </ul>

      <h2>Grievance Officer</h2>
      <p>
        Under the Consumer Protection (E-Commerce) Rules, 2020 and the DPDP Act, 2023:
      </p>
      <ul>
        <li>Name: {legal.grievanceName}</li>
        <li>Email: {legal.grievanceEmail}</li>
        <li>Address: {legal.address}</li>
      </ul>
      <p>
        We acknowledge complaints within 48 hours and aim to resolve them within one month of receipt.
      </p>

      <h2>Business details</h2>
      <ul>
        <li>{legal.entityName}</li>
        <li>{legal.address}</li>
        {legal.gstin ? <li>GSTIN: {legal.gstin}</li> : null}
        <li>Each kitchen&apos;s FSSAI registration is shown on its kitchen page.</li>
      </ul>
    </>
  );
}
