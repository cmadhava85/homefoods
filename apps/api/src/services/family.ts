import { eq } from "drizzle-orm";
import { familyLinks, users, type Db } from "@localmeals/db";
import { enqueueOutbox } from "./outboxEnqueue.js";

function normalizeMobile(mobile: string) {
  const trimmed = mobile.trim().replace(/[\s-]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("91") && trimmed.length === 12) return `+${trimmed}`;
  if (trimmed.length === 10) return `+91${trimmed}`;
  return trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
}

async function ensureUserRow(db: Db, mobile: string, fullName?: string) {
  const existing = await db.query.users.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, mobile),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({
      mobileNumber: mobile,
      fullName: fullName?.trim() || "Family",
      primaryAddress: "Address on file",
      pinCode: "600119",
      segment: "CHILD_PAYER",
    })
    .returning();
  return created;
}

export async function listFamilyLinksForMobile(db: Db, mobile: string) {
  const me = normalizeMobile(mobile);
  const rows = await db.query.familyLinks.findMany({
    where: (t, { eq: e, or: o }) =>
      o(e(t.seniorMobile, me), e(t.payerMobile, me)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
  });
  return rows.map((r) => ({
    id: r.id,
    seniorMobile: r.seniorMobile,
    payerMobile: r.payerMobile,
    status: r.status,
    createdAt: r.createdAt,
    activatedAt: r.activatedAt,
    role: r.seniorMobile === me ? ("SENIOR" as const) : ("PAYER" as const),
  }));
}

/** Senior invites a child/payer — PENDING until payer accepts. */
export async function requestFamilyLink(
  db: Db,
  input: { seniorMobile: string; payerMobile: string },
) {
  const { assertFeatureEnabled } = await import("./featureFlags.js");
  await assertFeatureEnabled(
    db,
    "child_pays_enabled",
    "Child Pays / Family is temporarily paused",
  );
  const seniorMobile = normalizeMobile(input.seniorMobile);
  const payerMobile = normalizeMobile(input.payerMobile);
  if (seniorMobile === payerMobile) {
    throw new Error("Payer must be a different mobile number");
  }
  await ensureUserRow(db, seniorMobile);
  await ensureUserRow(db, payerMobile);

  const existing = await db.query.familyLinks.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.seniorMobile, seniorMobile), e(t.payerMobile, payerMobile)),
  });
  if (existing) {
    if (existing.status === "REVOKED") {
      const [updated] = await db
        .update(familyLinks)
        .set({ status: "PENDING", activatedAt: null })
        .where(eq(familyLinks.id, existing.id))
        .returning();
      await enqueueOutbox(db, "FamilyLinkRequested", {
          linkId: updated.id,
          seniorMobile,
          payerMobile,
        });
      return updated;
    }
    return existing;
  }

  const [row] = await db
    .insert(familyLinks)
    .values({
      seniorMobile,
      payerMobile,
      status: "PENDING",
    })
    .returning();

  await enqueueOutbox(db, "FamilyLinkRequested", {
      linkId: row.id,
      seniorMobile,
      payerMobile,
    });
  return row;
}

export async function acceptFamilyLink(
  db: Db,
  input: { linkId: number; payerMobile: string },
) {
  const payerMobile = normalizeMobile(input.payerMobile);
  const link = await db.query.familyLinks.findFirst({
    where: (t, { eq: e }) => e(t.id, input.linkId),
  });
  if (!link) throw new Error("Invite not found");
  if (link.payerMobile !== payerMobile) {
    throw new Error("Only the invited payer can accept this link");
  }
  if (link.status === "ACTIVE") return link;
  if (link.status !== "PENDING") throw new Error(`Link is ${link.status}`);

  const [updated] = await db
    .update(familyLinks)
    .set({ status: "ACTIVE", activatedAt: new Date() })
    .where(eq(familyLinks.id, link.id))
    .returning();
  return updated;
}

export async function revokeFamilyLink(
  db: Db,
  input: { linkId: number; mobile: string },
) {
  const me = normalizeMobile(input.mobile);
  const link = await db.query.familyLinks.findFirst({
    where: (t, { eq: e }) => e(t.id, input.linkId),
  });
  if (!link) throw new Error("Link not found");
  if (link.seniorMobile !== me && link.payerMobile !== me) {
    throw new Error("Not your family link");
  }
  const [updated] = await db
    .update(familyLinks)
    .set({ status: "REVOKED" })
    .where(eq(familyLinks.id, link.id))
    .returning();
  return updated;
}

/** Active Child-Pays binding: senior places food, payer settles UPI. */
export async function assertActiveFamilyLink(
  db: Db,
  seniorMobile: string,
  payerMobile: string,
) {
  const senior = normalizeMobile(seniorMobile);
  const payer = normalizeMobile(payerMobile);
  if (senior === payer) {
    throw new Error("Choose a different mobile for Child Pays");
  }
  const link = await db.query.familyLinks.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.seniorMobile, senior), e(t.payerMobile, payer), e(t.status, "ACTIVE")),
  });
  if (!link) {
    throw new Error(
      "No active family link — invite this number under Family and have them accept first",
    );
  }
  return link;
}

export async function listActivePayersForSenior(db: Db, seniorMobile: string) {
  const senior = normalizeMobile(seniorMobile);
  const rows = await db.query.familyLinks.findMany({
    where: (t, { eq: e, and: a }) =>
      a(e(t.seniorMobile, senior), e(t.status, "ACTIVE")),
  });
  return rows.map((r) => r.payerMobile);
}

export { normalizeMobile as normalizeFamilyMobile };
