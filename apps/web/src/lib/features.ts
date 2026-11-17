"use client";

import { useEffect, useState } from "react";
import {
  defaultFeatureFlags,
  type FeatureFlagKey,
  type FeatureFlagsMap,
} from "@localmeals/domain";
import { API_BASE } from "@/lib/api";

export type { FeatureFlagKey, FeatureFlagsMap };

/** Live platform flags from `GET /meta/features` (Admin → Features). */
export function useFeatureFlags(): FeatureFlagsMap {
  const [flags, setFlags] = useState<FeatureFlagsMap>(() => defaultFeatureFlags());

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/meta/features`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok || cancelled) return;
        const next = { ...defaultFeatureFlags(), ...(json.flags as FeatureFlagsMap) };
        setFlags(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return flags;
}

export function flagOn(flags: FeatureFlagsMap, key: FeatureFlagKey): boolean {
  return flags[key] !== false;
}
