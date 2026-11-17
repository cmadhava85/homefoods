import { eq } from "drizzle-orm";
import { adminActionLog, platformFeatureFlags, type Db } from "@localmeals/db";
import {
  FEATURE_FLAG_DEFS,
  defaultFeatureFlags,
  isFeatureEnabled,
  type FeatureFlagKey,
  type FeatureFlagsMap,
} from "@localmeals/domain";

let cache: { at: number; flags: FeatureFlagsMap } | null = null;
const CACHE_MS = 5_000;

export async function ensureFeatureFlagRows(db: Db) {
  for (const def of FEATURE_FLAG_DEFS) {
    const existing = await db.query.platformFeatureFlags.findFirst({
      where: (t, { eq: e }) => e(t.key, def.key),
    });
    if (!existing) {
      await db.insert(platformFeatureFlags).values({
        key: def.key,
        enabled: def.defaultEnabled,
        label: def.label,
        description: def.description,
      });
    }
  }
}

export async function getFeatureFlags(db: Db): Promise<FeatureFlagsMap> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.flags;
  await ensureFeatureFlagRows(db);
  const rows = await db.query.platformFeatureFlags.findMany();
  const flags = defaultFeatureFlags();
  for (const row of rows) {
    if (row.key in flags) {
      flags[row.key as FeatureFlagKey] = row.enabled;
    }
  }
  cache = { at: Date.now(), flags };
  return flags;
}

export async function assertFeatureEnabled(db: Db, key: FeatureFlagKey, message?: string) {
  const flags = await getFeatureFlags(db);
  if (!isFeatureEnabled(flags, key)) {
    throw new Error(message ?? `Feature “${key}” is turned off by admin`);
  }
}

export async function listFeatureFlagsForAdmin(db: Db) {
  await ensureFeatureFlagRows(db);
  const rows = await db.query.platformFeatureFlags.findMany({
    orderBy: (t, { asc }) => [asc(t.key)],
  });
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return FEATURE_FLAG_DEFS.map((def) => {
    const row = byKey.get(def.key);
    return {
      key: def.key,
      label: row?.label ?? def.label,
      description: row?.description ?? def.description,
      enabled: row?.enabled ?? def.defaultEnabled,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

export async function setFeatureFlag(
  db: Db,
  input: { key: string; enabled: boolean; actor?: string },
) {
  const def = FEATURE_FLAG_DEFS.find((d) => d.key === input.key);
  if (!def) throw new Error(`Unknown feature flag: ${input.key}`);
  await ensureFeatureFlagRows(db);
  const actor = input.actor ?? "admin";
  await db
    .update(platformFeatureFlags)
    .set({
      enabled: input.enabled,
      updatedAt: new Date(),
      updatedBy: actor,
    })
    .where(eq(platformFeatureFlags.key, def.key));

  await db.insert(adminActionLog).values({
    actor,
    action: input.enabled ? "FEATURE_FLAG_ON" : "FEATURE_FLAG_OFF",
    entityType: "feature_flag",
    entityId: def.key,
    reason: input.enabled ? "Enabled via admin" : "Disabled via admin",
    payload: { key: def.key, enabled: input.enabled },
  });

  cache = null;
  return listFeatureFlagsForAdmin(db);
}

export function clearFeatureFlagCache() {
  cache = null;
}
