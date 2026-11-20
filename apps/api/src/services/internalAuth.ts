import { timingSafeEqual } from "node:crypto";
import type { Db } from "@localmeals/db";
import {
  getSessionUserFromRequestAsync,
  requireRole,
  type AuthRole,
  type SessionUser,
} from "./auth.js";

export type InternalAuthResult =
  | { kind: "token" }
  | { kind: "session"; user: SessionUser };

function headerToken(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers["x-internal-token"] ?? headers["X-Internal-Token"];
  return typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
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
 * Cloud Scheduler / worker shared secret, **or** signed-in cook/admin (desk UI).
 *
 * - Matching `X-Internal-Token` always allowed when `INTERNAL_JOB_TOKEN` is set.
 * - Local/dev with no token configured stays open (tests / cook desk without auth).
 * - Production requires either the job token or a valid staff session.
 */
export async function assertInternalOrRoles(
  db: Db,
  headers: Record<string, string | string[] | undefined>,
  roles: AuthRole[],
): Promise<InternalAuthResult> {
  const expected = process.env.INTERNAL_JOB_TOKEN?.trim();
  const got = headerToken(headers);

  if (expected && got && tokensEqual(expected, got)) return { kind: "token" };

  if (!expected && process.env.NODE_ENV !== "production") {
    return { kind: "token" };
  }

  if (process.env.NODE_ENV === "production" && !expected) {
    throw new Error("INTERNAL_JOB_TOKEN is required in production");
  }

  const user = requireRole(await getSessionUserFromRequestAsync(db, headers), roles);
  return { kind: "session", user };
}
