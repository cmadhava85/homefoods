/**
 * Public UI path for the ops console (not `/admin`).
 * Override at build/runtime with NEXT_PUBLIC_ADMIN_PATH (no leading slash).
 * Internal App Router folder stays `app/admin/*`; middleware rewrites.
 */
const DEFAULT_ADMIN_PATH = "lm-ops-k7v2m9";

function sanitize(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (!cleaned || cleaned === "admin" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(cleaned)) {
    return DEFAULT_ADMIN_PATH;
  }
  return cleaned;
}

/** URL segment after the leading slash, e.g. `lm-ops-k7v2m9`. */
export function adminPathPrefix(): string {
  return sanitize(process.env.NEXT_PUBLIC_ADMIN_PATH ?? DEFAULT_ADMIN_PATH);
}

/** Browser href for the ops console (`/lm-ops-…` or a subpath). */
export function adminHref(subpath = ""): string {
  const base = `/${adminPathPrefix()}`;
  const rest = subpath.replace(/^\/+/, "");
  return rest ? `${base}/${rest}` : base;
}

export function isAdminUiPath(pathname: string): boolean {
  const base = `/${adminPathPrefix()}`;
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Map public ops URL → internal `/admin…` path for rewrite. */
export function toInternalAdminPath(pathname: string): string | null {
  if (!isAdminUiPath(pathname)) return null;
  const prefix = `/${adminPathPrefix()}`;
  const rest = pathname.slice(prefix.length);
  return rest ? `/admin${rest}` : "/admin";
}
