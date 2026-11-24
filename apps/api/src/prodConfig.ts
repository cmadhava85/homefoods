/**
 * Fail closed in production when required secrets / flags are missing or still on mock defaults.
 * Call once at process boot (apps/api/src/index.ts).
 *
 * Staging (`APP_ENV=staging`) may keep MOCK_AUTH / MOCK_WHATSAPP on — Meta test numbers
 * are allowlist-gated, so demo OTP 123456 is the practical login path there.
 * MOCK_PAYMENTS and AUTH_ENFORCE stay strict even in staging.
 */
export function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;

  const staging =
    (process.env.APP_ENV ?? "").trim().toLowerCase() === "staging";
  const missing: string[] = [];
  const weak: string[] = [];

  if (!process.env.DATABASE_URL?.trim()) missing.push("DATABASE_URL");
  if (!process.env.AUTH_SECRET?.trim()) missing.push("AUTH_SECRET");
  if (process.env.AUTH_SECRET === "localmeals-dev-auth-secret") {
    weak.push("AUTH_SECRET is still the local default");
  }
  if (!process.env.INTERNAL_JOB_TOKEN?.trim()) missing.push("INTERNAL_JOB_TOKEN");
  if (!process.env.WEB_ORIGIN?.trim()) missing.push("WEB_ORIGIN");

  if (process.env.MOCK_PAYMENTS !== "false") {
    weak.push("MOCK_PAYMENTS must be false in production");
  }
  if (!staging && process.env.MOCK_WHATSAPP !== "false") {
    weak.push("MOCK_WHATSAPP must be false in production");
  }
  if (!staging && process.env.MOCK_AUTH !== "false") {
    weak.push("MOCK_AUTH must be false in production");
  }
  if (process.env.AUTH_ENFORCE === "false") {
    weak.push("AUTH_ENFORCE must not be false in production");
  }
  // No default admin on a production service (incl. APP_ENV=staging) — fail at boot, not at first login.
  if (!process.env.ADMIN_MOBILES?.trim()) {
    missing.push("ADMIN_MOBILES");
  }

  if (process.env.MOCK_PAYMENTS === "false") {
    for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) {
      if (!process.env[k]?.trim()) missing.push(k);
    }
  }
  if (process.env.MOCK_WHATSAPP === "false") {
    for (const k of [
      "WHATSAPP_VERIFY_TOKEN",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_ACCESS_TOKEN",
      "WHATSAPP_PHONE_NUMBER_ID",
    ]) {
      if (!process.env[k]?.trim()) missing.push(k);
    }
  }

  if (missing.length || weak.length) {
    const lines = [
      "[api] Production configuration invalid:",
      ...missing.map((m) => `  - missing ${m}`),
      ...weak.map((w) => `  - ${w}`),
      "See docs/SECURITY.md and docs/MVP1_LAUNCH.md",
    ];
    throw new Error(lines.join("\n"));
  }
}
