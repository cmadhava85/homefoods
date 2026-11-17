import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

export function testMobile(prefix = "99") {
  return `+91${prefix}${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`.slice(
    0,
    15,
  );
}

/** Mock OTP login as CUSTOMER; returns bearer headers + mobile. */
export async function loginCustomer(
  app: FastifyInstance,
  mobile = testMobile(),
): Promise<{ mobile: string; token: string; headers: { authorization: string } }> {
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
  const auth = await loginCustomer(app, mobile);
  const addressId = await ensureHomeAddress(app, auth.headers);
  return { ...auth, addressId };
}

const COOK_MOBILES: Record<string, string> = {
  "sri-sai": "+919876543210",
  "amma-priya": "+919876543211",
  "millet-box": "+919876543212",
};

/** Mock OTP login as ADMIN (default ADMIN_MOBILES includes +919900000001). */
export async function loginAdmin(
  app: FastifyInstance,
  mobile = "+919900000001",
): Promise<{ mobile: string; token: string; headers: { authorization: string } }> {
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
  slug = "sri-sai",
): Promise<{ mobile: string; token: string; headers: { authorization: string }; slug: string }> {
  const mobile = COOK_MOBILES[slug] ?? COOK_MOBILES["sri-sai"]!;
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
