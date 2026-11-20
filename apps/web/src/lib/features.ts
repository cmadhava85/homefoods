"use client";

import { useEffect, useState } from "react";
import {
  defaultFeatureFlags,
  type FeatureFlagKey,
  type FeatureFlagsMap,
} from "@localmeals/domain";
import { API_BASE } from "@/lib/api";

export type { FeatureFlagKey, FeatureFlagsMap };

const CLIENT_CACHE_MS = 60_000;
let cached: { at: number; flags: FeatureFlagsMap } | null = null;
let inflight: Promise<FeatureFlagsMap> | null = null;

/** One shared GET /meta/features for the whole tab (Header + Footer + pages). */
export function loadFeatureFlags(): Promise<FeatureFlagsMap> {
  if (cached && Date.now() - cached.at < CLIENT_CACHE_MS) {
    return Promise.resolve(cached.flags);
  }
  if (inflight) return inflight;
  inflight = fetch(`${API_BASE}/meta/features`)
    .then(async (r) => {
      const json = await r.json();
      if (!r.ok) return defaultFeatureFlags();
      const flags = {
        ...defaultFeatureFlags(),
        ...(json.flags as FeatureFlagsMap),
      };
      cached = { at: Date.now(), flags };
      return flags;
    })
    .catch(() => defaultFeatureFlags())
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Live platform flags from `GET /meta/features` (Admin → Features). */
export function useFeatureFlags(): FeatureFlagsMap {
  const [flags, setFlags] = useState<FeatureFlagsMap>(
    () => cached?.flags ?? defaultFeatureFlags(),
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

export function flagOn(flags: FeatureFlagsMap, key: FeatureFlagKey): boolean {
  return flags[key] !== false;
}
