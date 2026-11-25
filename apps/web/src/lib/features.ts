"use client";

import { useEffect, useState } from "react";
import {
  defaultFeatureFlags,
  type FeatureFlagKey,
  type FeatureFlagsMap,
} from "@localmeals/domain";
import { API_BASE } from "@/lib/api";
import { platformFeePaise as fallbackPlatformFeePaise } from "@/lib/soloKitchen";

export type { FeatureFlagKey, FeatureFlagsMap };

/** Customer-facing pricing from `GET /meta/features` (Admin → Pricing). */
export type PlatformPricing = { platformFeePaise: number };

type MetaSnapshot = { flags: FeatureFlagsMap; pricing: PlatformPricing };

const CLIENT_CACHE_MS = 60_000;
let cached: { at: number; meta: MetaSnapshot } | null = null;
let inflight: Promise<MetaSnapshot> | null = null;

function fallbackMeta(): MetaSnapshot {
  return {
    flags: defaultFeatureFlags(),
    pricing: { platformFeePaise: fallbackPlatformFeePaise() },
  };
}

/** One shared GET /meta/features for the whole tab (flags + pricing). */
function loadMeta(): Promise<MetaSnapshot> {
  if (cached && Date.now() - cached.at < CLIENT_CACHE_MS) {
    return Promise.resolve(cached.meta);
  }
  if (inflight) return inflight;
  inflight = fetch(`${API_BASE}/meta/features`)
    .then(async (r) => {
      const json = await r.json();
      if (!r.ok) return fallbackMeta();
      const fee = json.pricing?.platformFeePaise;
      const meta: MetaSnapshot = {
        flags: { ...defaultFeatureFlags(), ...(json.flags as FeatureFlagsMap) },
        pricing: {
          platformFeePaise:
            typeof fee === "number" && Number.isFinite(fee) && fee >= 0
              ? fee
              : fallbackPlatformFeePaise(),
        },
      };
      cached = { at: Date.now(), meta };
      return meta;
    })
    .catch(() => fallbackMeta())
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function loadFeatureFlags(): Promise<FeatureFlagsMap> {
  return loadMeta().then((m) => m.flags);
}

export function loadPlatformPricing(): Promise<PlatformPricing> {
  return loadMeta().then((m) => m.pricing);
}

/** Live platform flags from `GET /meta/features` (Admin → Features). */
export function useFeatureFlags(): FeatureFlagsMap {
  const [flags, setFlags] = useState<FeatureFlagsMap>(
    () => cached?.meta.flags ?? defaultFeatureFlags(),
  );

  useEffect(() => {
    let cancelled = false;
    loadFeatureFlags().then((next) => {
      if (!cancelled) setFlags(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return flags;
}

/** Live customer platform fee per checkout (admin-editable). */
export function usePlatformFeePaise(): number {
  const [fee, setFee] = useState<number>(
    () => cached?.meta.pricing.platformFeePaise ?? fallbackPlatformFeePaise(),
  );

  useEffect(() => {
    let cancelled = false;
    loadPlatformPricing().then((p) => {
      if (!cancelled) setFee(p.platformFeePaise);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return fee;
}

export function flagOn(flags: FeatureFlagsMap, key: FeatureFlagKey): boolean {
  return flags[key] !== false;
}
