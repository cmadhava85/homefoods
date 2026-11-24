/**
 * Business identity shown on policy pages. Set NEXT_PUBLIC_LEGAL_* at build time;
 * until all required values are present the pages show a "draft" banner.
 */
const env = (key: string) => process.env[key]?.trim() ?? "";

export const legal = {
  entityName: env("NEXT_PUBLIC_LEGAL_ENTITY_NAME") || "[Registered business name]",
  address: env("NEXT_PUBLIC_LEGAL_ADDRESS") || "[Registered address, Chennai, Tamil Nadu]",
  supportEmail: env("NEXT_PUBLIC_SUPPORT_EMAIL") || "[support email]",
  supportPhone: env("NEXT_PUBLIC_SUPPORT_PHONE") || "[support WhatsApp / phone]",
  grievanceName: env("NEXT_PUBLIC_GRIEVANCE_OFFICER_NAME") || "[Grievance Officer name]",
  grievanceEmail: env("NEXT_PUBLIC_GRIEVANCE_OFFICER_EMAIL") || "[grievance email]",
  gstin: env("NEXT_PUBLIC_LEGAL_GSTIN"),
  effectiveDate: env("NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE") || "[effective date]",
};

const REQUIRED = [
  "NEXT_PUBLIC_LEGAL_ENTITY_NAME",
  "NEXT_PUBLIC_LEGAL_ADDRESS",
  "NEXT_PUBLIC_SUPPORT_EMAIL",
  "NEXT_PUBLIC_GRIEVANCE_OFFICER_NAME",
  "NEXT_PUBLIC_GRIEVANCE_OFFICER_EMAIL",
  "NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE",
];

export function legalDetailsMissing(): string[] {
  return REQUIRED.filter((k) => !env(k));
}
