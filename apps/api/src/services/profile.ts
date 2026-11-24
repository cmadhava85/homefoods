import { eq } from "drizzle-orm";
import { users, type Db } from "@localmeals/db";
import { listAddressesForMobile } from "./addresses.js";
import { isLocale, type Locale } from "@localmeals/i18n";

function normalizeMobile(mobile: string) {
  const digits = mobile.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (mobile.startsWith("+") && digits.length >= 10) return `+${digits}`;
  throw new Error("Enter a valid Indian mobile number");
}

function normalizePin(pin: string) {
  const p = pin.replace(/\D/g, "").slice(0, 6);
  if (p.length !== 6) throw new Error("PIN code must be 6 digits");
  return p;
}

/** Ensure a users row exists (WhatsApp language / address before OTP). */
export async function ensureCustomerUser(
  db: Db,
  mobile: string,
  opts?: { preferredLanguage?: Locale; pinCode?: string },
) {
  const userMobile = normalizeMobile(mobile);
  const existing = await db.query.users.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, userMobile),
  });
  if (existing) {
    if (opts?.preferredLanguage && existing.preferredLanguage !== opts.preferredLanguage) {
      const [updated] = await db
        .update(users)
        .set({ preferredLanguage: opts.preferredLanguage })
        .where(eq(users.mobileNumber, userMobile))
        .returning();
      return updated;
    }
    return existing;
  }
  const [created] = await db
    .insert(users)
    .values({
      mobileNumber: userMobile,
      fullName: "Guest",
      primaryAddress: "Address on file",
      pinCode: opts?.pinCode ?? "600119",
      preferredLanguage: opts?.preferredLanguage ?? "en",
      segment: "BACHELOR",
    })
    .returning();
  return created;
}

export async function getCustomerPreferredLocale(db: Db, mobile: string): Promise<Locale | null> {
  try {
    const userMobile = normalizeMobile(mobile);
    const row = await db.query.users.findFirst({
      where: (t, { eq: e }) => e(t.mobileNumber, userMobile),
    });
    if (row && isLocale(row.preferredLanguage)) return row.preferredLanguage;
  } catch {
    /* ignore */
  }
  return null;
}

/** Marketing WA (menu alerts) — STOP sets true; START clears. Transactional order WA still allowed. */
export async function isWaMarketingOptedOut(db: Db, mobile: string): Promise<boolean> {
  try {
    const userMobile = normalizeMobile(mobile);
    const row = await db.query.users.findFirst({
      where: (t, { eq: e }) => e(t.mobileNumber, userMobile),
    });
    const consents = (row?.consents ?? {}) as Record<string, unknown>;
    return consents.waMarketingOptOut === true;
  } catch {
    return false;
  }
}

export async function setWaMarketingOptOut(db: Db, mobile: string, optedOut: boolean) {
  await ensureCustomerUser(db, mobile);
  const userMobile = normalizeMobile(mobile);
  const row = await db.query.users.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, userMobile),
  });
  if (!row) return;
  const consents = {
    ...((row.consents ?? {}) as Record<string, unknown>),
    waMarketingOptOut: optedOut,
    waMarketingOptOutAt: new Date().toISOString(),
  };
  await db
    .update(users)
    .set({ consents })
    .where(eq(users.mobileNumber, userMobile));
}

export async function getCustomerProfile(db: Db, mobile: string) {
  const userMobile = normalizeMobile(mobile);
  const row = await db.query.users.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, userMobile),
  });
  if (!row) throw new Error("Customer not found");
  const addressList = await listAddressesForMobile(db, userMobile);
  const consents = (row.consents ?? {}) as Record<string, boolean>;
  return {
    mobile: row.mobileNumber,
    fullName: row.fullName,
    pinCode: row.pinCode,
    preferredLanguage: row.preferredLanguage,
    addresses: addressList,
    needsName: !row.fullName || row.fullName === "Guest",
    leanWaStatus: consents.leanWaStatus === true,
  };
}

export async function updateCustomerProfile(
  db: Db,
  input: {
    mobile: string;
    fullName?: string;
    pinCode?: string;
    preferredLanguage?: string;
    leanWaStatus?: boolean;
  },
) {
  const userMobile = normalizeMobile(input.mobile);
  const row = await db.query.users.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, userMobile),
  });
  if (!row) throw new Error("Customer not found");

  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.fullName != null) {
    const fullName = input.fullName.trim().slice(0, 80);
    if (fullName.length < 2) throw new Error("Enter your name (at least 2 characters)");
    patch.fullName = fullName;
  }
  if (input.pinCode != null) {
    patch.pinCode = normalizePin(input.pinCode);
  }
  if (input.preferredLanguage != null) {
    const lang = input.preferredLanguage.trim().toLowerCase().slice(0, 5);
    if (lang !== "en" && lang !== "ta") throw new Error("Language must be en or ta");
    patch.preferredLanguage = lang;
  }
  if (input.leanWaStatus !== undefined) {
    const consents: Record<string, unknown> = {
      ...((row.consents ?? {}) as Record<string, unknown>),
      leanWaStatus: Boolean(input.leanWaStatus),
    };
    patch.consents = consents;
  }
  if (!Object.keys(patch).length) throw new Error("Nothing to update");

  const [updated] = await db
    .update(users)
    .set(patch)
    .where(eq(users.mobileNumber, userMobile))
    .returning();

  const consents = (updated.consents ?? {}) as Record<string, boolean>;
  return {
    mobile: updated.mobileNumber,
    fullName: updated.fullName,
    pinCode: updated.pinCode,
    preferredLanguage: updated.preferredLanguage,
    needsName: !updated.fullName || updated.fullName === "Guest",
    leanWaStatus: consents.leanWaStatus === true,
  };
}
