import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { authOtps, authRevocations, cookProfiles, users, type Db } from "@localmeals/db";

export type AuthRole = "CUSTOMER" | "COOK" | "ADMIN";

export type SessionUser = {
  mobile: string;
  role: AuthRole;
  fullName: string;
  pinCode?: string;
  cookSlug?: string;
  cookId?: string;
};

type TokenPayload = SessionUser & { exp: number; iat: number };

const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const OTP_REQUEST_MAX = 5;

/** In-process request throttle (best-effort across instances). */
const otpRequestBuckets = new Map<string, { count: number; resetAt: number }>();

function normalizeMobile(mobile: string) {
  const trimmed = mobile.trim().replace(/[\s-]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("91") && trimmed.length === 12) return `+${trimmed}`;
  if (trimmed.length === 10) return `+91${trimmed}`;
  return trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
}

function adminMobiles(): Set<string> {
  const raw = process.env.ADMIN_MOBILES ?? "+919900000001";
  return new Set(
    raw
      .split(",")
      .map((m) => normalizeMobile(m))
      .filter(Boolean),
  );
}

function mockOtpEnabled() {
  return process.env.MOCK_AUTH !== "false";
}

function authSecret() {
  const secret = process.env.AUTH_SECRET ?? "localmeals-dev-auth-secret";
  if (
    process.env.NODE_ENV === "production" &&
    (!process.env.AUTH_SECRET || process.env.AUTH_SECRET === "localmeals-dev-auth-secret")
  ) {
    throw new Error("AUTH_SECRET must be set to a strong value in production");
  }
  return secret;
}

function hashOtp(code: string) {
  return createHash("sha256").update(`${authSecret()}:otp:${code}`).digest("hex");
}

function codesEqual(a: string, b: string) {
  try {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function b64url(input: string | Buffer) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromB64url(input: string) {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Signed token — survives API restarts; logout revokes via auth_revocations. */
function issueToken(user: SessionUser) {
  const now = Date.now();
  const payload: TokenPayload = {
    ...user,
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", authSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function parseTokenRaw(token: string): { user: SessionUser; iat: number } | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", authSecret()).update(body).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(fromB64url(body)) as TokenPayload;
    if (!payload?.mobile || !payload?.role || !payload.exp) return null;
    if (payload.exp < Date.now()) return null;
    const iat = typeof payload.iat === "number" ? payload.iat : 0;
    const { exp: _exp, iat: _iat, ...user } = payload;
    return { user, iat };
  } catch {
    return null;
  }
}

function parseToken(token: string): SessionUser | null {
  return parseTokenRaw(token)?.user ?? null;
}

function assertOtpRequestAllowed(key: string) {
  const now = Date.now();
  const bucket = otpRequestBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    otpRequestBuckets.set(key, { count: 1, resetAt: now + OTP_REQUEST_WINDOW_MS });
    return;
  }
  if (bucket.count >= OTP_REQUEST_MAX) {
    throw new Error("Too many OTP requests — wait a few minutes and try again");
  }
  bucket.count += 1;
}

async function deliverOtp(mobile: string, code: string, role: AuthRole) {
  if (mockOtpEnabled()) {
    console.log(`[mock-auth] OTP for ${role} ${mobile}: ${code}`);
    return;
  }
  const { getWhatsAppProvider } = await import("@localmeals/adapters");
  const wa = getWhatsAppProvider();
  await wa.send({
    to: mobile,
    body: `LocalMeals code: ${code}\nValid 10 minutes. Do not share.`,
  });
}

export async function requestOtp(
  db: Db,
  input: { mobile: string; role: AuthRole },
) {
  const mobile = normalizeMobile(input.mobile);
  if (!/^\+[1-9]\d{7,14}$/.test(mobile)) {
    throw new Error("Enter a valid mobile with country code (e.g. +9198…)");
  }

  if (input.role === "ADMIN" && !adminMobiles().has(mobile)) {
    throw new Error("This mobile is not an admin account");
  }

  if (input.role === "COOK") {
    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.mobileNumber, mobile),
    });
    if (!cook) throw new Error("No kitchen registered for this mobile");
    // Applicants cannot desk-login until ops Approves LIVE (platform-issued access).
    if (cook.onboardingStatus !== "LIVE" || !cook.isActive) {
      throw new Error(
        "Kitchen not LIVE yet — LocalMeals will message you on WhatsApp when desk access is ready",
      );
    }
  }

  if (input.role === "CUSTOMER") {
    const existing = await db.query.users.findFirst({
      where: (t, { eq: e }) => e(t.mobileNumber, mobile),
    });
    if (!existing) {
      await db.insert(users).values({
        mobileNumber: mobile,
        fullName: "Guest",
        primaryAddress: "Address on file",
        pinCode: "600119",
        segment: "BACHELOR",
      });
    }
  }

  const rateKey = `${input.role}:${mobile}`;
  assertOtpRequestAllowed(rateKey);

  const code = mockOtpEnabled() ? "123456" : String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await db
    .insert(authOtps)
    .values({
      mobileNumber: mobile,
      role: input.role,
      codeHash: hashOtp(code),
      expiresAt,
      attempts: 0,
    })
    .onConflictDoUpdate({
      target: [authOtps.mobileNumber, authOtps.role],
      set: {
        codeHash: hashOtp(code),
        expiresAt,
        attempts: 0,
        createdAt: new Date(),
      },
    });

  // Best-effort cleanup of expired rows
  await db.delete(authOtps).where(lt(authOtps.expiresAt, new Date())).catch(() => undefined);

  await deliverOtp(mobile, code, input.role);

  return {
    ok: true,
    mobile,
    role: input.role,
    expiresInSec: OTP_TTL_MS / 1000,
    mockCode: mockOtpEnabled() ? code : undefined,
  };
}

async function resolveUser(
  db: Db,
  role: AuthRole,
  mobile: string,
): Promise<SessionUser> {
  if (role === "ADMIN") {
    if (!adminMobiles().has(mobile)) throw new Error("Not an admin mobile");
    return { mobile, role: "ADMIN", fullName: "Owner" };
  }
  if (role === "COOK") {
    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.mobileNumber, mobile),
    });
    if (!cook) throw new Error("Cook not found");
    if (cook.onboardingStatus !== "LIVE" || !cook.isActive) {
      throw new Error(
        "Kitchen not LIVE yet — LocalMeals will message you on WhatsApp when desk access is ready",
      );
    }
    return {
      mobile,
      role: "COOK",
      fullName: cook.kitchenName,
      cookSlug: cook.slugHandle,
      cookId: cook.id,
    };
  }
  let row = await db.query.users.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, mobile),
  });
  if (!row) {
    const [created] = await db
      .insert(users)
      .values({
        mobileNumber: mobile,
        fullName: "Guest",
        primaryAddress: "Address on file",
        pinCode: "600119",
        segment: "BACHELOR",
      })
      .returning();
    row = created;
  }
  return {
    mobile,
    role: "CUSTOMER",
    fullName: row.fullName || "Guest",
    pinCode: row.pinCode || "600119",
  };
}

export async function verifyOtp(
  db: Db,
  input: { mobile: string; role: AuthRole; code: string },
) {
  const mobile = normalizeMobile(input.mobile);
  const code = input.code.trim();

  // Local/dev: UI pre-fills 123456 and copy says demo OTP is always that —
  // allow sign-in without a prior Send OTP when MOCK_AUTH is on.
  if (mockOtpEnabled() && code === "123456") {
    await db
      .delete(authOtps)
      .where(and(eq(authOtps.mobileNumber, mobile), eq(authOtps.role, input.role)))
      .catch(() => undefined);
    const user = await resolveUser(db, input.role, mobile);
    const token = issueToken(user);
    return {
      token,
      user,
      expiresInSec: SESSION_TTL_MS / 1000,
    };
  }

  const rec = await db.query.authOtps.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.mobileNumber, mobile), e(t.role, input.role)),
  });

  if (!rec || rec.expiresAt.getTime() < Date.now()) {
    if (rec) {
      await db
        .delete(authOtps)
        .where(and(eq(authOtps.mobileNumber, mobile), eq(authOtps.role, input.role)));
    }
    throw new Error(
      mockOtpEnabled()
        ? "OTP expired — tap Send OTP again (dev code is 123456)"
        : "OTP expired — tap Send OTP again",
    );
  }

  if (rec.attempts >= OTP_MAX_ATTEMPTS) {
    await db
      .delete(authOtps)
      .where(and(eq(authOtps.mobileNumber, mobile), eq(authOtps.role, input.role)));
    throw new Error("Too many invalid OTP attempts — request a new code");
  }

  const expectedHash = hashOtp(code);
  const ok = codesEqual(rec.codeHash, expectedHash);

  if (!ok) {
    await db
      .update(authOtps)
      .set({ attempts: rec.attempts + 1 })
      .where(and(eq(authOtps.mobileNumber, mobile), eq(authOtps.role, input.role)));
    throw new Error("Invalid OTP");
  }

  await db
    .delete(authOtps)
    .where(and(eq(authOtps.mobileNumber, mobile), eq(authOtps.role, input.role)));

  const user = await resolveUser(db, input.role, mobile);
  const token = issueToken(user);

  return {
    token,
    user,
    expiresInSec: SESSION_TTL_MS / 1000,
  };
}

export const SESSION_COOKIE = "lm_session";

export function parseSessionToken(token: string | undefined | null): SessionUser | null {
  if (!token?.trim()) return null;
  return parseToken(token.trim());
}

export function getSessionUser(authorizationHeader?: string): SessionUser | null {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  return parseSessionToken(authorizationHeader.slice("Bearer ".length));
}

function extractRawToken(headers: {
  authorization?: string | string[] | undefined;
  cookie?: string | string[] | undefined;
}): string | null {
  const auth = headers.authorization;
  const bearer = typeof auth === "string" ? auth : Array.isArray(auth) ? auth[0] : undefined;
  if (bearer?.startsWith("Bearer ")) {
    const t = bearer.slice("Bearer ".length).trim();
    if (t) return t;
  }
  const raw = headers.cookie;
  const cookieHeader = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)lm_session=([^;]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/** Sync parse only (no revoke check) — prefer async variant with db. */
export function getSessionUserFromRequest(headers: {
  authorization?: string | string[] | undefined;
  cookie?: string | string[] | undefined;
}): SessionUser | null {
  const token = extractRawToken(headers);
  return token ? parseSessionToken(token) : null;
}

/** Bearer / cookie + DB logout revoke check. */
export async function getSessionUserFromRequestAsync(
  db: Db,
  headers: {
    authorization?: string | string[] | undefined;
    cookie?: string | string[] | undefined;
  },
): Promise<SessionUser | null> {
  const token = extractRawToken(headers);
  if (!token) return null;
  const parsed = parseTokenRaw(token);
  if (!parsed) return null;
  const row = await db.query.authRevocations.findFirst({
    where: (t, { eq: e, and: a }) =>
      a(e(t.mobileNumber, parsed.user.mobile), e(t.role, parsed.user.role)),
  });
  if (row && parsed.iat <= row.revokedBefore.getTime()) return null;
  return parsed.user;
}

function cookieSecure() {
  const web = process.env.WEB_ORIGIN ?? "";
  return process.env.NODE_ENV === "production" || web.startsWith("https");
}

/** HttpOnly session cookie — Path=/ so Next `/lm-api` proxy keeps it first-party. */
export function sessionCookieHeader(token: string, maxAgeSec = SESSION_TTL_MS / 1000) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    `Max-Age=${Math.floor(maxAgeSec)}`,
    "SameSite=Lax",
  ];
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookieHeader() {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Max-Age=0",
    "SameSite=Lax",
  ];
  if (cookieSecure()) parts.push("Secure");
  return parts.join("; ");
}

/** Invalidate all tokens for this mobile+role issued at or before now. */
export async function revokeSessions(
  db: Db,
  user: { mobile: string; role: AuthRole } | null | undefined,
) {
  if (!user?.mobile || !user.role) return { ok: true as const };
  const revokedBefore = new Date();
  await db
    .insert(authRevocations)
    .values({
      mobileNumber: user.mobile,
      role: user.role,
      revokedBefore,
      updatedAt: revokedBefore,
    })
    .onConflictDoUpdate({
      target: [authRevocations.mobileNumber, authRevocations.role],
      set: { revokedBefore, updatedAt: revokedBefore },
    });
  return { ok: true as const };
}

export function logoutSession(_authorizationHeader?: string) {
  return { ok: true };
}

/**
 * Fail closed in production unless AUTH_ENFORCE is explicitly "false".
 * Local/tests default open when AUTH_ENFORCE unset / false.
 */
export function authEnforced() {
  if (process.env.AUTH_ENFORCE === "true") return true;
  if (process.env.AUTH_ENFORCE === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function requireRole(
  user: SessionUser | null,
  roles: AuthRole[],
): SessionUser {
  if (!user || !roles.includes(user.role)) {
    throw new Error("Unauthorized");
  }
  return user;
}

/** COOK for this slug, or ADMIN. Always required (not gated by AUTH_ENFORCE). */
export function requireKitchenStaff(
  user: SessionUser | null,
  slug: string,
): SessionUser {
  const staff = requireRole(user, ["COOK", "ADMIN"]);
  if (staff.role === "COOK" && staff.cookSlug !== slug) {
    throw new Error("Not your kitchen");
  }
  return staff;
}

export async function findCookSlugForMobile(db: Db, mobile: string) {
  const cook = await db.query.cookProfiles.findFirst({
    where: eq(cookProfiles.mobileNumber, mobile),
  });
  return cook?.slugHandle ?? null;
}
