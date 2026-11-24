import Link from "next/link";
import { legal, legalDetailsMissing } from "@/lib/legal";

const LINKS = [
  ["/legal/terms", "Terms"],
  ["/legal/privacy", "Privacy"],
  ["/legal/refunds", "Cancellation & refunds"],
  ["/legal/delivery", "Delivery"],
  ["/legal/contact", "Contact & grievances"],
] as const;

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  const missing = legalDetailsMissing();
  return (
    <main className="legal-page">
      <nav className="legal-nav" aria-label="Policies">
        {LINKS.map(([href, label]) => (
          <Link key={href} href={href}>
            {label}
          </Link>
        ))}
      </nav>
      {missing.length > 0 ? (
        <p className="legal-draft" role="note">
          Draft — pending legal review. Business details not yet configured: {missing.join(", ")}.
        </p>
      ) : null}
      {children}
      <p className="muted">Effective: {legal.effectiveDate}</p>
    </main>
  );
}
