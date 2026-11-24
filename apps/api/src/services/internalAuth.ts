import { timingSafeEqual } from "node:crypto";
import type { Db } from "@localmeals/db";
import {
  getSessionUserFromRequestAsync,
  requireRole,
  type AuthRole,
  type SessionUser,
} from "./auth.js";

export type InternalAuthResult =
  | { kind: "token"; caller: JobCaller }
  | { kind: "session"; user: SessionUser };

/** Allowed values for `X-Job-Caller` on internal-token / OIDC job traffic. */
export const JOB_CALLERS = ["scheduler", "worker", "owner"] as const;
export type JobCaller = (typeof JOB_CALLERS)[number];

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const raw = headers[lower] ?? headers[name];
  return typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
}

function headerToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  return headerValue(headers, "x-internal-token");
}

function tokensEqual(a: string, b: string) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Resolve audit actor for Scheduler / worker jobs.
 * Unknown or missing header → `"owner"` (legacy internal-token callers).
 */
export function resolveJobCaller(
  headers: Record<string, string | string[] | undefined>,
): JobCaller {
  const raw = (headerValue(headers, "x-job-caller") ?? "").trim().toLowerCase();
  if ((JOB_CALLERS as readonly string[]).includes(raw)) return raw as JobCaller;
  return "owner";
}

/**
 * Migration stub: when `INTERNAL_OIDC_STUB=true`, accept any non-empty
 * `Authorization: Bearer …` as Scheduler OIDC. Full Google JWKS verification
 * is documented in RUNBOOK — do not enable the stub in production long-term.
 */
export function oidcStubAccepted(
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (process.env.INTERNAL_OIDC_STUB !== "true") return false;
  const auth = headerValue(headers, "authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length).trim();
  return token.length >= 20;
}

/**
 * Cloud Scheduler / worker shared secret, OIDC stub, **or** signed-in cook/admin (desk UI).
 *
 * - Matching `X-Internal-Token` always allowed when `INTERNAL_JOB_TOKEN` is set.
 * - Optional OIDC stub (`INTERNAL_OIDC_STUB=true` + Bearer) during Scheduler migration.
 * - Local/dev with no token configured stays open (tests / cook desk without auth).
 * - Production requires either the job token / OIDC stub or a valid staff session.
 */
export async function assertInternalOrRoles(
  db: Db,
  headers: Record<string, string | string[] | undefined>,
  roles: AuthRole[],
): Promise<InternalAuthResult> {
  const expected = process.env.INTERNAL_JOB_TOKEN?.trim();
  const got = headerToken(headers);
  const caller = resolveJobCaller(headers);

  if (expected && got && tokensEqual(expected, got)) {
    return { kind: "token", caller };
  }

  if (oidcStubAccepted(headers)) {
    return { kind: "token", caller: caller === "owner" ? "scheduler" : caller };
  }

  if (!expected && process.env.NODE_ENV !== "production") {
    return { kind: "token", caller };
  }

  if (process.env.NODE_ENV === "production" && !expected) {
    throw new Error("INTERNAL_JOB_TOKEN is required in production");
  }

  const user = requireRole(await getSessionUserFromRequestAsync(db, headers), roles);
  return { kind: "session", user };
}
