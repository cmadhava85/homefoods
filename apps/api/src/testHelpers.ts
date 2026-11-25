import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { createDb } from "@localmeals/db";

/** Clear Postgres rate-limit buckets so OTP login tests are not flaky across suites. */
export async function clearRateLimitBuckets() {
  const db = createDb();
  try {
    await db.execute(sql`DELETE FROM rate_limit_buckets`);
  } finally {
    // leave pooled connection; createDb is lightweight shared client in tests
  }
}

/**
 * Seed kitchens default to 40 plates/day. Full API suites + local Playwright leave
 * soft holds (AWAITING_PAYMENT / kitchen states) that exhaust that quickly.
 * Re-apply on login helpers so suites that restore capacity to 40 don't flake later.
 */
const TEST_KITCHEN_CAPACITY = 100_000;

export async function ensureTestKitchenCapacity() {
  const db = createDb();
  await db.execute(
    sql`UPDATE cook_profiles SET max_daily_capacity = ${TEST_KITCHEN_CAPACITY}
        WHERE max_daily_capacity < ${TEST_KITCHEN_CAPACITY}`,
  );
}

export function testMobile(prefix = "99") {
  // Prefer entropy over Date.now() — mock.timers freezes Date in late-order tests and
  // would otherwise collapse many customers onto ~10 mobiles.
  const entropy = `${process.hrtime.bigint()}${Math.floor(Math.random() * 1e6)}`.replace(/\D/g, "");
  return `+91${prefix}${entropy}`.slice(0, 15);
}

/** Mock OTP login as CUSTOMER; returns bearer headers + mobile. */
export async function loginCustomer(
  app: FastifyInstance,
  mobile = testMobile(),
): Promise<{ mobile: string; token: string; headers: { authorization: string } }> {
  await clearRateLimitBuckets();
  const req = await app.inject({
    method: "POST",
    url: "/auth/otp/request",
    payload: { mobile, role: "CUSTOMER" },
  });
  assert.equal(req.statusCode, 200, req.body);
  const code = req.json().mockCode ?? "123456";
  const verify = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: { mobile, role: "CUSTOMER", code },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const token = verify.json().token as string;
  return { mobile, token, headers: { authorization: `Bearer ${token}` } };
}

/** Ensure customer has a HOME address; returns its id. */
export async function ensureHomeAddress(
  app: FastifyInstance,
  headers: { authorization: string },
  line1 = "Test Tower, Flat 101, OMR",
  pinCode = "600119",
): Promise<number> {
  const listed = await app.inject({ method: "GET", url: "/me/addresses", headers });
  assert.equal(listed.statusCode, 200, listed.body);
  const existing = (listed.json().addresses as Array<{ id: number; label: string }>).find(
    (a) => a.label === "HOME",
  );
  if (existing) return existing.id;

  const created = await app.inject({
    method: "POST",
    url: "/me/addresses",
    headers,
    payload: { label: "HOME", line1, pinCode, isDefault: true },
  });
  assert.equal(created.statusCode, 200, created.body);
  return created.json().id as number;
}

/** Login + HOME address for web checkout payloads. */
export async function customerWithAddress(app: FastifyInstance, mobile = testMobile()) {
  await ensureTestKitchenCapacity();
  const auth = await loginCustomer(app, mobile);
  const addressId = await ensureHomeAddress(app, auth.headers);
  return { ...auth, addressId };
}

const COOK_MOBILES: Record<string, string> = {
  "csk-homemade-delights": "+919876543210",
  "amma-priya": "+919876543211",
  "millet-box": "+919876543212",
};

/** Mock OTP login as ADMIN (default ADMIN_MOBILES includes +919900000001). */
export async function loginAdmin(
  app: FastifyInstance,
  mobile = "+919900000001",
): Promise<{ mobile: string; token: string; headers: { authorization: string } }> {
  await clearRateLimitBuckets();
  const req = await app.inject({
    method: "POST",
    url: "/auth/otp/request",
    payload: { mobile, role: "ADMIN" },
  });
  assert.equal(req.statusCode, 200, req.body);
  const code = req.json().mockCode ?? "123456";
  const verify = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: { mobile, role: "ADMIN", code },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const token = verify.json().token as string;
  return { mobile, token, headers: { authorization: `Bearer ${token}` } };
}

/** Mock OTP login as COOK for a kitchen slug. */
export async function loginCook(
  app: FastifyInstance,
  slug = "csk-homemade-delights",
): Promise<{ mobile: string; token: string; headers: { authorization: string }; slug: string }> {
  await ensureTestKitchenCapacity();
  await clearRateLimitBuckets();
  const mobile = COOK_MOBILES[slug] ?? COOK_MOBILES["csk-homemade-delights"]!;
  const req = await app.inject({
    method: "POST",
    url: "/auth/otp/request",
    payload: { mobile, role: "COOK" },
  });
  assert.equal(req.statusCode, 200, req.body);
  const code = req.json().mockCode ?? "123456";
  const verify = await app.inject({
    method: "POST",
    url: "/auth/otp/verify",
    payload: { mobile, role: "COOK", code },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const token = verify.json().token as string;
  return { mobile, token, headers: { authorization: `Bearer ${token}` }, slug };
}
