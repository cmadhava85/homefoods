import { createHash } from "node:crypto";

type KeyedRequest = {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
};

function firstHeader(v: string | string[] | undefined) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Rate-limit bucket key. Behind Cloud Run / the Next proxy `req.ip` is often a shared proxy
 * address, so signed-in callers are keyed by a hash of their session token (one user can't
 * exhaust everyone's quota). Anonymous callers fall back to the client IP.
 */
export function rateLimitKey(req: KeyedRequest): string {
  const auth = firstHeader(req.headers.authorization);
  let token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    const cookie = firstHeader(req.headers.cookie) ?? "";
    token = cookie.match(/(?:^|;\s*)lm_session=([^;]+)/)?.[1] ?? "";
  }
  if (token) return `s:${createHash("sha256").update(token).digest("hex").slice(0, 32)}`;
  return `ip:${req.ip}`;
}

/**
 * Fastify `trustProxy` from TRUST_PROXY: "true", a hop count ("1"), or a comma-separated
 * CIDR/IP list. Unset = off. Only set it once the deployed hop chain is verified — trusting
 * too many hops lets clients spoof X-Forwarded-For.
 */
export function trustProxySetting(
  raw = process.env.TRUST_PROXY,
): boolean | string[] | ((address: string, hop: number) => boolean) {
  const v = raw?.trim();
  if (!v || v === "false") return false;
  if (v === "true") return true;
  // Hop count: trust the nearest N proxies (Fastify's types accept the equivalent function form).
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (_address: string, hop: number) => hop < hops;
  }
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
