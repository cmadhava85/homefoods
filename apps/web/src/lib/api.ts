/**
 * Browser calls go through Next rewrite `/lm-api` → API so `lm_session`
 * HttpOnly cookies stay first-party. Server components hit the API directly.
 */
const INTERNAL_API =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://127.0.0.1:4000";

export const API_BASE =
  typeof window === "undefined"
    ? INTERNAL_API
    : process.env.NEXT_PUBLIC_API_PROXY === "false"
      ? (process.env.NEXT_PUBLIC_API_URL ?? INTERNAL_API)
      : "/lm-api";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `API ${res.status}`);
  }
  return res.json() as Promise<T>;
}
