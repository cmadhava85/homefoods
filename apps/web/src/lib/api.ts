/**
 * Browser calls go through Next rewrite `/lm-api` → API so `lm_session`
 * HttpOnly cookies stay first-party. Server components hit the API directly
 * and must forward the browser Cookie header (credentials: "include" alone
 * does not attach the user's session on the server).
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

async function serverCookieHeader(): Promise<string | undefined> {
  if (typeof window !== "undefined") return undefined;
  try {
    const { cookies } = await import("next/headers");
    const jar = await cookies();
    const all = jar.getAll();
    if (!all.length) return undefined;
    return all.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return undefined;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const cookie = await serverCookieHeader();
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (cookie && !headers.has("Cookie")) {
    headers.set("Cookie", cookie);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers,
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `API ${res.status}`);
  }
  return res.json() as Promise<T>;
}
