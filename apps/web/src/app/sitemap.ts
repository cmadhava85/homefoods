import type { MetadataRoute } from "next";
import { LEGAL_PATHS, siteUrl } from "@/lib/site";

export const revalidate = 3600;

async function kitchenSlugs(): Promise<string[]> {
  const api = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
  if (!api) return [];
  try {
    const res = await fetch(`${api}/kitchens`, { next: { revalidate } });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ slug?: unknown }>;
    return rows.map((r) => r.slug).filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const now = new Date();
  const fixed = ["/", "/discover", ...LEGAL_PATHS].map((path) => ({
    url: `${base}${path === "/" ? "" : path}`,
    lastModified: now,
  }));
  const kitchens = (await kitchenSlugs()).map((slug) => ({
    url: `${base}/kitchen/${encodeURIComponent(slug)}`,
    lastModified: now,
    changeFrequency: "daily" as const,
  }));
  return [...fixed, ...kitchens];
}
