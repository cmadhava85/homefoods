import { eq } from "drizzle-orm";
import { adminActionLog, cookProfiles, platformSettings, type Db } from "@localmeals/db";
import {
  DEFAULT_COOK_COMMISSION_BPS,
  DomainError,
  MAX_COOK_COMMISSION_BPS,
  MAX_PLATFORM_FEE_PAISE,
  PLATFORM_FEE_PAISE,
  effectiveCommissionBps,
} from "@localmeals/domain";
import { isSoloKitchenMode } from "../soloKitchen.js";

export const PLATFORM_FEE_KEY = "platform_fee_paise";
export const COOK_COMMISSION_KEY = "cook_commission_bps";

export type PlatformPricing = {
  platformFeePaise: number;
  cookCommissionBps: number;
};

let cache: { at: number; pricing: PlatformPricing } | null = null;
const CACHE_MS = 5_000;

/** First-boot values: solo launch keeps its ₹0 fee until an admin changes it. */
function seedValues(): Record<string, number> {
  return {
    [PLATFORM_FEE_KEY]: isSoloKitchenMode() ? 0 : PLATFORM_FEE_PAISE,
    [COOK_COMMISSION_KEY]: DEFAULT_COOK_COMMISSION_BPS,
  };
}

async function ensurePricingRows(db: Db) {
  const seeds = seedValues();
  await db
    .insert(platformSettings)
    .values(Object.entries(seeds).map(([key, intValue]) => ({ key, intValue })))
    .onConflictDoNothing();
}

async function loadRows(db: Db) {
  await ensurePricingRows(db);
  const rows = await db.query.platformSettings.findMany();
  return new Map(rows.map((r) => [r.key, r]));
}

/** Live platform fee + default cook commission (cached briefly, like feature flags). */
export async function getPlatformPricing(db: Db): Promise<PlatformPricing> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.pricing;
  const rows = await loadRows(db);
  const seeds = seedValues();
  const pricing = {
    platformFeePaise: rows.get(PLATFORM_FEE_KEY)?.intValue ?? seeds[PLATFORM_FEE_KEY],
    cookCommissionBps: rows.get(COOK_COMMISSION_KEY)?.intValue ?? seeds[COOK_COMMISSION_KEY],
  };
  cache = { at: Date.now(), pricing };
  return pricing;
}

/** Commission to snapshot on a new order / booking for this cook. */
export async function commissionBpsForCook(
  db: Db,
  cook: { commissionBps?: number | null },
): Promise<number> {
  const { cookCommissionBps } = await getPlatformPricing(db);
  return effectiveCommissionBps(cookCommissionBps, cook.commissionBps);
}

export async function getPricingForAdmin(db: Db) {
  const rows = await loadRows(db);
  const pricing = await getPlatformPricing(db);
  const fee = rows.get(PLATFORM_FEE_KEY);
  const commission = rows.get(COOK_COMMISSION_KEY);
  const latest = [fee, commission]
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
  return {
    ...pricing,
    maxPlatformFeePaise: MAX_PLATFORM_FEE_PAISE,
    maxCookCommissionBps: MAX_COOK_COMMISSION_BPS,
    updatedAt: latest?.updatedAt ?? null,
    updatedBy: latest?.updatedBy ?? null,
  };
}

function assertInRange(value: number, max: number, label: string) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new DomainError(`${label} must be between 0 and ${max}`, 400, "pricing_out_of_range");
  }
}

export async function setPlatformPricing(
  db: Db,
  input: { platformFeePaise?: number; cookCommissionBps?: number; actor?: string },
) {
  const changes: Array<[string, number]> = [];
  if (input.platformFeePaise !== undefined) {
    assertInRange(input.platformFeePaise, MAX_PLATFORM_FEE_PAISE, "Platform fee (paise)");
    changes.push([PLATFORM_FEE_KEY, input.platformFeePaise]);
  }
  if (input.cookCommissionBps !== undefined) {
    assertInRange(input.cookCommissionBps, MAX_COOK_COMMISSION_BPS, "Cook commission (bps)");
    changes.push([COOK_COMMISSION_KEY, input.cookCommissionBps]);
  }
  if (!changes.length) throw new DomainError("Nothing to update", 400, "pricing_empty");

  await ensurePricingRows(db);
  const before = await getPlatformPricing(db);
  const actor = input.actor ?? "admin";
  for (const [key, intValue] of changes) {
    await db
      .update(platformSettings)
      .set({ intValue, updatedAt: new Date(), updatedBy: actor })
      .where(eq(platformSettings.key, key));
  }
  cache = null;
  await db.insert(adminActionLog).values({
    actor,
    action: "PRICING_UPDATED",
    entityType: "platform_settings",
    entityId: changes.map(([k]) => k).join(","),
    reason: "Updated via admin",
    payload: { before, after: Object.fromEntries(changes) },
  });
  return getPricingForAdmin(db);
}

/** Per-cook commission override; null restores the platform default. */
export async function setCookCommission(
  db: Db,
  input: { cookId: string; commissionBps: number | null; actor?: string },
) {
  if (input.commissionBps !== null) {
    assertInRange(input.commissionBps, MAX_COOK_COMMISSION_BPS, "Cook commission (bps)");
  }
  const existing = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.id, input.cookId),
  });
  if (!existing) throw DomainError.notFound("Cook not found");
  const [row] = await db
    .update(cookProfiles)
    .set({ commissionBps: input.commissionBps })
    .where(eq(cookProfiles.id, input.cookId))
    .returning();
  await db.insert(adminActionLog).values({
    actor: input.actor ?? "admin",
    action: "COOK_COMMISSION_SET",
    entityType: "cook",
    entityId: input.cookId,
    reason: input.commissionBps === null ? "Reset to platform default" : "Override via admin",
    payload: { before: existing.commissionBps, after: input.commissionBps },
  });
  return row;
}

export function clearPlatformPricingCache() {
  cache = null;
}
