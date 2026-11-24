/**
 * Normalise a `?next=` redirect target to a same-origin path, or return null.
 * Prefix checks alone are bypassable: browsers resolve "/\evil.com" and "/\t/evil.com" to
 * https://evil.com, so resolve the URL and require the origin to be unchanged.
 */
export function sameOriginPath(next: string | null | undefined, origin: string): string | null {
  const raw = next?.trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return null;
  // Backslashes and control characters are never legitimate in our paths.
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const url = new URL(raw, origin);
    if (url.origin !== new URL(origin).origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
