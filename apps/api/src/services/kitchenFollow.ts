import { and, eq } from "drizzle-orm";
import { cookProfiles, kitchenFollowers, users, type Db } from "@localmeals/db";

function normalizeMobile(mobile: string) {
  return mobile.startsWith("+") ? mobile : `+${mobile.replace(/^\+/, "")}`;
}

async function ensureCustomer(db: Db, mobile: string, pinCode: string) {
  const customerMobile = normalizeMobile(mobile);
  const existing = await db.query.users.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, customerMobile),
  });
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({
      mobileNumber: customerMobile,
      fullName: "WhatsApp customer",
      primaryAddress: "Address on file / TBD",
      pinCode,
    })
    .returning();
  return created;
}

export async function followKitchen(
  db: Db,
  customerMobile: string,
  cookSlug: string,
  opts: { consent?: boolean; consentVia?: "web_confirm" | "whatsapp_command" } = {},
) {
  const { assertFeatureEnabled } = await import("./featureFlags.js");
  await assertFeatureEnabled(
    db,
    "kitchen_follow_enabled",
    "Kitchen follow alerts are temporarily paused",
  );
  if (!opts.consent) {
    throw new Error(
      "Confirm to get WhatsApp when this kitchen posts a new plate (Unfollow anytime)",
    );
  }
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error(`Kitchen "${cookSlug}" not found`);
  const user = await ensureCustomer(db, customerMobile, cook.pinCode);
  const existing = await db.query.kitchenFollowers.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.cookId, cook.id), e(t.customerMobile, user.mobileNumber)),
  });
  if (existing) {
    return {
      alreadyFollowing: true,
      cook: { kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
    };
  }
  await db.insert(kitchenFollowers).values({
    cookId: cook.id,
    customerMobile: user.mobileNumber,
  });
  // Record alert consent for DPDP-style audit (Follow = menu WA alerts).
  const prev = (user.consents ?? {}) as Record<string, unknown>;
  const consents: Record<string, unknown> = {
    ...prev,
    menuWaAlerts: true,
    menuWaAlertsAt: new Date().toISOString(),
    menuWaAlertsVia: opts.consentVia ?? "web_confirm",
  };
  await db
    .update(users)
    .set({ consents })
    .where(eq(users.mobileNumber, user.mobileNumber));
  return {
    alreadyFollowing: false,
    cook: { kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
  };
}

export async function unfollowKitchen(db: Db, customerMobile: string, cookSlug: string) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error(`Kitchen "${cookSlug}" not found`);
  const mobile = normalizeMobile(customerMobile);
  await db
    .delete(kitchenFollowers)
    .where(
      and(eq(kitchenFollowers.cookId, cook.id), eq(kitchenFollowers.customerMobile, mobile)),
    );
  return { cook: { kitchenName: cook.kitchenName, slugHandle: cook.slugHandle } };
}

export async function listFollowedKitchens(db: Db, customerMobile: string) {
  const mobile = normalizeMobile(customerMobile);
  const rows = await db.query.kitchenFollowers.findMany({
    where: (t, { eq: e }) => e(t.customerMobile, mobile),
  });
  if (!rows.length) return [];
  const cooks = await db.query.cookProfiles.findMany();
  const byId = new Map(cooks.map((c) => [c.id, c]));
  return rows
    .map((r) => byId.get(r.cookId))
    .filter(Boolean)
    .map((c) => ({
      kitchenName: c!.kitchenName,
      slugHandle: c!.slugHandle,
    }));
}

/** Followed + recent kitchens for customer home / Discover strip. */
export async function listMyKitchens(db: Db, customerMobile: string) {
  const mobile = normalizeMobile(customerMobile);
  const { nextOpenSlotForCook } = await import("./orders.js");
  const followedRows = await db.query.kitchenFollowers.findMany({
    where: (t, { eq: e }) => e(t.customerMobile, mobile),
  });
  const recentOrders = await db.query.orders.findMany({
    where: (t, { eq: e, or: o }) =>
      o(e(t.customerMobile, mobile), e(t.payerMobile, mobile)),
    orderBy: (t, { desc }) => [desc(t.createdAt)],
    limit: 40,
  });
  const cooks = await db.query.cookProfiles.findMany();
  const byId = new Map(cooks.map((c) => [c.id, c]));
  const followedIds = new Set(followedRows.map((r) => r.cookId));
  const recentIds: string[] = [];
  for (const o of recentOrders) {
    if (!recentIds.includes(o.cookId)) recentIds.push(o.cookId);
  }
  const mergedIds = [
    ...followedRows.map((r) => r.cookId),
    ...recentIds.filter((id) => !followedIds.has(id)),
  ].slice(0, 12);

  const out = [];
  for (const id of mergedIds) {
    const cook = byId.get(id);
    if (!cook || cook.onboardingStatus !== "LIVE" || !cook.isActive || !cook.fssaiNumber) {
      continue;
    }
    const slot = await nextOpenSlotForCook(db, cook, "LUNCH");
    out.push({
      id: cook.id,
      kitchenName: cook.kitchenName,
      slugHandle: cook.slugHandle,
      pinCode: cook.pinCode,
      followed: followedIds.has(id),
      recent: recentIds.includes(id),
      orderingOpen: slot.orderingOpen,
      nextServiceDate: slot.nextServiceDate,
      openStatusLabel: slot.statusLabel,
      lunchCutoff: slot.cutoffLabel,
      deliveryWindow: slot.deliveryWindow,
    });
  }
  return out;
}

export async function listKitchenFollowerMobiles(db: Db, cookId: string) {
  const rows = await db.query.kitchenFollowers.findMany({
    where: (t, { eq: e }) => e(t.cookId, cookId),
  });
  return rows.map((r) => r.customerMobile);
}
