import { API_BASE } from "@/lib/api";

/**
 * Image URL for an uploaded photo. Menu photos are served straight from the public GCS bucket
 * (NEXT_PUBLIC_MENU_IMAGES_BASE, e.g. https://storage.googleapis.com/<bucket>) so they never hit
 * the API; everything else (concern photos) stays behind the API.
 */
export function uploadSrc(
  url: string | null | undefined,
  publicMenuBase: string | undefined = process.env.NEXT_PUBLIC_MENU_IMAGES_BASE,
): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  const base = publicMenuBase?.trim().replace(/\/+$/, "");
  const menu = /^\/uploads\/(menu-[A-Za-z0-9._-]+)$/.exec(url);
  if (base && menu) return `${base}/${menu[1]}`;
  return `${API_BASE}${url}`;
}
