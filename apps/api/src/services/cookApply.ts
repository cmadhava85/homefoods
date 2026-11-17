import { eq } from "drizzle-orm";
import { cookProfiles, type Db } from "@localmeals/db";
import { hasCookPayoutDetails } from "@localmeals/domain";

function normalizeMobile(mobile: string) {
  const trimmed = mobile.trim().replace(/[\s-]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("91") && trimmed.length === 12) return `+${trimmed}`;
  if (/^\d{10}$/.test(trimmed)) return `+91${trimmed}`;
  return trimmed;
}

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "kitchen";
}

function normalizeFssai(raw: string) {
  return raw.replace(/\s+/g, "").trim();
}

async function uniqueSlug(db: Db, kitchenName: string) {
  const base = slugify(kitchenName);
  const existing = await db.query.cookProfiles.findMany({
    where: (t, { like: l }) => l(t.slugHandle, `${base}%`),
    columns: { slugHandle: true },
  });
  const taken = new Set(existing.map((r) => r.slugHandle));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`.slice(0, 50);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36).slice(-4)}`.slice(0, 50);
}

export type CookApplyInput = {
  mobile: string;
  kitchenName: string;
  pinCode: string;
  fssaiNumber?: string | null;
  payoutUpiId?: string | null;
  payoutAccountNote?: string | null;
  pickupLandmark?: string | null;
  /** Must be true — cook acknowledges quality / refund / pause standards. */
  acceptedKitchenStandards: boolean;
};

/**
 * Public cook enrollment → DRAFT/DOCS_SUBMITTED profile.
 * Ops reviews FSSAI + payout in Admin before LIVE.
 */
export async function applyAsCook(db: Db, input: CookApplyInput) {
  if (!input.acceptedKitchenStandards) {
    throw new Error("Accept the kitchen standards to apply");
  }

  const mobile = normalizeMobile(input.mobile);
  if (!/^\+91\d{10}$/.test(mobile)) {
    throw new Error("Enter a valid Indian mobile (+91…)");
  }

  const kitchenName = input.kitchenName.trim();
  if (kitchenName.length < 3) throw new Error("Kitchen name is too short");
  if (kitchenName.length > 100) throw new Error("Kitchen name is too long");

  const pinCode = input.pinCode.trim();
  if (!/^\d{6}$/.test(pinCode)) throw new Error("Enter a 6-digit pin code");

  const fssaiRaw = input.fssaiNumber?.trim() ? normalizeFssai(input.fssaiNumber) : "";
  if (fssaiRaw && !/^\d{14}$/.test(fssaiRaw)) {
    throw new Error("FSSAI must be a 14-digit licence number (or leave blank for now)");
  }
  const fssaiNumber = fssaiRaw || null;

  const payoutUpiId = input.payoutUpiId?.trim() || null;
  const payoutAccountNote = input.payoutAccountNote?.trim() || null;
  const pickupLandmark = input.pickupLandmark?.trim() || null;

  if (!payoutUpiId && !payoutAccountNote) {
    throw new Error("Add a UPI ID or bank payout note so we can pay you");
  }

  const existing = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, mobile),
  });
  if (existing) {
    if (existing.onboardingStatus === "LIVE") {
      throw new Error("This mobile is already a LIVE kitchen — sign in as cook");
    }
    throw new Error(
      `Application already on file (${existing.onboardingStatus}) for /${existing.slugHandle}. Ops will review soon.`,
    );
  }

  const slugHandle = await uniqueSlug(db, kitchenName);
  // FSSAI still required before LIVE; optional at apply → DRAFT until number is on file
  const onboardingStatus = fssaiNumber ? ("DOCS_SUBMITTED" as const) : ("DRAFT" as const);

  const [row] = await db
    .insert(cookProfiles)
    .values({
      mobileNumber: mobile,
      kitchenName,
      slugHandle,
      pinCode,
      fssaiNumber,
      payoutUpiId,
      payoutAccountNote,
      pickupLandmark,
      onboardingStatus,
      isActive: false,
    })
    .returning();

  return {
    ok: true as const,
    id: row.id,
    slugHandle: row.slugHandle,
    kitchenName: row.kitchenName,
    onboardingStatus: row.onboardingStatus,
    message: fssaiNumber
      ? "Thanks — application received. Ops will verify FSSAI and payout, then WhatsApp you when the desk is LIVE."
      : "Thanks — application received. Ops still needs your FSSAI before LIVE; we’ll WhatsApp you when desk access is ready.",
  };
}

/** Admin: promote DOCS_SUBMITTED (or DRAFT with docs) → LIVE when gates pass. */
export async function adminApproveCookLive(db: Db, cookId: string) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, cookId),
  });
  if (!cook) throw new Error("Cook not found");
  if (cook.onboardingStatus === "LIVE" && cook.isActive) {
    return cook;
  }
  if (cook.onboardingStatus === "REJECTED") {
    throw new Error("Rejected kitchens cannot be approved — update status in DB first");
  }
  if (!cook.fssaiNumber?.trim()) {
    throw new Error("FSSAI number required before LIVE");
  }
  if (
    !hasCookPayoutDetails({
      onboardingStatus: cook.onboardingStatus,
      fssaiNumber: cook.fssaiNumber,
      isActive: cook.isActive,
      payoutUpiId: cook.payoutUpiId,
      payoutAccountNote: cook.payoutAccountNote,
      payoutBeneficiaryRef: cook.payoutBeneficiaryRef,
    })
  ) {
    throw new Error("Add UPI, bank note, or Route account before LIVE");
  }

  const [updated] = await db
    .update(cookProfiles)
    .set({
      onboardingStatus: "LIVE",
      isActive: true,
      fssaiVerifiedAt: cook.fssaiVerifiedAt ?? new Date(),
    })
    .where(eq(cookProfiles.id, cookId))
    .returning();

  // Platform-issued desk access: WhatsApp the cook mobile on the profile
  try {
    const { getWhatsAppProvider } = await import("@localmeals/adapters");
    const web = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
    await getWhatsAppProvider().send({
      to: updated.mobileNumber,
      body: [
        `✅ ${updated.kitchenName} is LIVE on LocalMeals.`,
        `Sign in with this WhatsApp number + OTP:`,
        `${web}/login?role=cook&next=/cook/${updated.slugHandle}`,
        `Desk: ${web}/cook/${updated.slugHandle}`,
        "",
        "Quality reminders: hygiene is yours; customer refunds/holds go through LocalMeals ops.",
      ].join("\n"),
      buttons: ["Status", "Menu"],
    });
  } catch (err) {
    console.warn("[approve] LIVE WhatsApp invite failed", err);
  }

  return updated;
}

export async function listCooksForAdmin(db: Db) {
  const rows = await db.query.cookProfiles.findMany({
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  // Pending applications first
  return [...rows].sort((a, b) => {
    const rank = (s: string) =>
      s === "DOCS_SUBMITTED" || s === "DRAFT" || s === "GATEWAY_KYC_PENDING" ? 0 : s === "LIVE" ? 2 : 1;
    return rank(a.onboardingStatus) - rank(b.onboardingStatus);
  });
}
