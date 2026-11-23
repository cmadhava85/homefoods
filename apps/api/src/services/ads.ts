import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { adCampaigns, type Db } from "@localmeals/db";
import { isFeatureEnabled } from "@localmeals/domain";
import { assertFeatureEnabled, getFeatureFlags } from "./featureFlags.js";

export type AdCampaignDto = {
  id: number;
  type: "KITCHEN_BOOST" | "EXTERNAL";
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ENDED";
  pinCode: string;
  cookId: string | null;
  cookSlug: string | null;
  kitchenName: string | null;
  title: string;
  body: string | null;
  ctaUrl: string | null;
  imageUrl: string | null;
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
};

function rowToDto(
  row: typeof adCampaigns.$inferSelect,
  cook?: { slugHandle: string; kitchenName: string } | null,
): AdCampaignDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    pinCode: row.pinCode,
    cookId: row.cookId,
    cookSlug: cook?.slugHandle ?? null,
    kitchenName: cook?.kitchenName ?? null,
    title: row.title,
    body: row.body,
    ctaUrl: row.ctaUrl,
    imageUrl: row.imageUrl,
    priority: row.priority,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

async function cooksByIds(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, { slugHandle: string; kitchenName: string }>();
  const rows = await db.query.cookProfiles.findMany({
    where: (t, { inArray: ia }) => ia(t.id, ids),
  });
  return new Map(rows.map((c) => [c.id, { slugHandle: c.slugHandle, kitchenName: c.kitchenName }]));
}

/** Active campaigns for a pin (empty when ads_enabled is off). */
export async function listActiveAdsForPin(db: Db, pinCode: string) {
  const flags = await getFeatureFlags(db);
  if (!isFeatureEnabled(flags, "ads_enabled")) {
    return { adsEnabled: false as const, boosts: [] as AdCampaignDto[], external: [] as AdCampaignDto[] };
  }

  const now = new Date();
  const rows = await db
    .select()
    .from(adCampaigns)
    .where(
      and(
        eq(adCampaigns.pinCode, pinCode),
        eq(adCampaigns.status, "ACTIVE"),
        or(isNull(adCampaigns.startsAt), lte(adCampaigns.startsAt, now)),
        or(isNull(adCampaigns.endsAt), gte(adCampaigns.endsAt, now)),
      ),
    )
    .orderBy(desc(adCampaigns.priority), desc(adCampaigns.id));

  const cookMap = await cooksByIds(
    db,
    rows.map((r) => r.cookId).filter((id): id is string => Boolean(id)),
  );
  const dtos = rows.map((r) => rowToDto(r, r.cookId ? cookMap.get(r.cookId) : null));
  return {
    adsEnabled: true as const,
    boosts: dtos.filter((d) => d.type === "KITCHEN_BOOST"),
    external: dtos.filter((d) => d.type === "EXTERNAL"),
  };
}

/** Cook ids with an active boost in this pin (for Discover sort / badge). */
export async function activeBoostCookIds(db: Db, pinCode: string): Promise<Set<string>> {
  const { adsEnabled, boosts } = await listActiveAdsForPin(db, pinCode);
  if (!adsEnabled) return new Set();
  return new Set(boosts.map((b) => b.cookId).filter((id): id is string => Boolean(id)));
}

export async function listAdCampaignsAdmin(db: Db, opts: { pinCode?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const rows = opts.pinCode
    ? await db
        .select()
        .from(adCampaigns)
        .where(eq(adCampaigns.pinCode, opts.pinCode))
        .orderBy(desc(adCampaigns.updatedAt))
        .limit(limit)
    : await db.select().from(adCampaigns).orderBy(desc(adCampaigns.updatedAt)).limit(limit);

  const cookMap = await cooksByIds(
    db,
    rows.map((r) => r.cookId).filter((id): id is string => Boolean(id)),
  );
  const flags = await getFeatureFlags(db);
  return {
    adsEnabled: isFeatureEnabled(flags, "ads_enabled"),
    campaigns: rows.map((r) => rowToDto(r, r.cookId ? cookMap.get(r.cookId) : null)),
  };
}

export async function adminUpsertAdCampaign(
  db: Db,
  input: {
    id?: number;
    type: "KITCHEN_BOOST" | "EXTERNAL";
    status: "DRAFT" | "ACTIVE" | "PAUSED" | "ENDED";
    pinCode: string;
    cookId?: string | null;
    title: string;
    body?: string | null;
    ctaUrl?: string | null;
    imageUrl?: string | null;
    priority?: number;
    startsAt?: Date | null;
    endsAt?: Date | null;
    actor?: string;
  },
) {
  if (!/^\d{6}$/.test(input.pinCode)) throw new Error("pinCode must be 6 digits");
  if (input.type === "KITCHEN_BOOST" && !input.cookId) {
    throw new Error("Kitchen boost needs a cookId");
  }
  if (input.type === "EXTERNAL" && input.cookId) {
    throw new Error("External ads cannot bind a cookId");
  }

  const patch = {
    type: input.type,
    status: input.status,
    pinCode: input.pinCode,
    cookId: input.cookId ?? null,
    title: input.title.trim().slice(0, 120),
    body: input.body?.trim() || null,
    ctaUrl: input.ctaUrl?.trim() || null,
    imageUrl: input.imageUrl?.trim() || null,
    priority: input.priority ?? 0,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    updatedAt: new Date(),
    createdBy: input.actor ?? "admin",
  };

  if (input.id) {
    const [updated] = await db
      .update(adCampaigns)
      .set(patch)
      .where(eq(adCampaigns.id, input.id))
      .returning();
    if (!updated) throw new Error("Campaign not found");
    return rowToDto(updated);
  }

  const [created] = await db
    .insert(adCampaigns)
    .values({
      ...patch,
      createdAt: new Date(),
    })
    .returning();
  return rowToDto(created);
}

export async function adminSetAdCampaignStatus(
  db: Db,
  id: number,
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "ENDED",
) {
  const [updated] = await db
    .update(adCampaigns)
    .set({ status, updatedAt: new Date() })
    .where(eq(adCampaigns.id, id))
    .returning();
  if (!updated) throw new Error("Campaign not found");
  return rowToDto(updated);
}

/**
 * Cook requests a pin boost — creates DRAFT for admin to activate.
 * Requires ads_enabled (otherwise clear error).
 */
export async function requestCookKitchenBoost(
  db: Db,
  cookSlug: string,
  input: { title?: string; days?: number } = {},
) {
  await assertFeatureEnabled(
    db,
    "ads_enabled",
    "Kitchen boosts are turned off by admin — ask LocalMeals when ads reopen",
  );
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  if (cook.onboardingStatus !== "LIVE" || !cook.isActive) {
    throw new Error("Only LIVE kitchens can request a boost");
  }

  const days = Math.min(Math.max(input.days ?? 7, 1), 30);
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + days * 24 * 60 * 60 * 1000);
  const title =
    input.title?.trim().slice(0, 120) || `Boost · ${cook.kitchenName} · ${days}d`;

  const [created] = await db
    .insert(adCampaigns)
    .values({
      type: "KITCHEN_BOOST",
      status: "DRAFT",
      pinCode: cook.pinCode,
      cookId: cook.id,
      title,
      body: "Cook-requested pin boost — admin activates when paid / approved.",
      priority: 10,
      startsAt,
      endsAt,
      createdBy: cook.slugHandle,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();

  return {
    campaign: rowToDto(created, { slugHandle: cook.slugHandle, kitchenName: cook.kitchenName }),
    note: "Draft submitted. Admin activates after payment / approval.",
  };
}

export async function listCookBoostCampaigns(db: Db, cookSlug: string) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, cookSlug),
  });
  if (!cook) throw new Error("Cook not found");
  const flags = await getFeatureFlags(db);
  const rows = await db
    .select()
    .from(adCampaigns)
    .where(and(eq(adCampaigns.cookId, cook.id), eq(adCampaigns.type, "KITCHEN_BOOST")))
    .orderBy(desc(adCampaigns.createdAt))
    .limit(20);
  return {
    adsEnabled: isFeatureEnabled(flags, "ads_enabled"),
    campaigns: rows.map((r) =>
      rowToDto(r, { slugHandle: cook.slugHandle, kitchenName: cook.kitchenName }),
    ),
  };
}
