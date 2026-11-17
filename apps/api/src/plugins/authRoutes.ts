import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@localmeals/db";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";
import {
  clearSessionCookieHeader,
  requestOtp,
  revokeSessions,
  sessionCookieHeader,
  verifyOtp,
} from "../services/auth.js";

export async function authRoutes(
  app: FastifyInstance,
  opts: { db: Db,
  auth: AuthHelpers },
) {
  const { db, auth } = opts;
  const { currentUser, assertAuthed, assertKitchenStaff, assertOrderKitchenStaff, bindCustomerMobile } = auth;
app.post(
  "/auth/otp/request",
  {
    config: {
      rateLimit: { max: 10, timeWindow: "15 minutes" },
    },
  },
  async (req, reply) => {
    const body = z
      .object({
        mobile: z.string().min(8),
        role: z.enum(["CUSTOMER", "COOK", "ADMIN"]),
      })
      .parse(req.body);
    try {
      return await requestOtp(db, body);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  },
);

app.post(
  "/auth/otp/verify",
  {
    config: {
      rateLimit: { max: 20, timeWindow: "15 minutes" },
    },
  },
  async (req, reply) => {
    const body = z
      .object({
        mobile: z.string().min(8),
        role: z.enum(["CUSTOMER", "COOK", "ADMIN"]),
        code: z.string().min(4).max(8),
      })
      .parse(req.body);
    try {
      const result = await verifyOtp(db, body);
      reply.header("Set-Cookie", sessionCookieHeader(result.token, result.expiresInSec));
      return result;
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  },
);

app.get("/auth/me", async (req, reply) => {
  const user = currentUser(req);
  if (!user) return reply.code(401).send({ error: "Not signed in" });
  // Migrate legacy localStorage Bearer → HttpOnly cookie when proxied via /lm-api
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token) reply.header("Set-Cookie", sessionCookieHeader(token));
  }
  return { user };
});

app.post("/auth/logout", async (req, reply) => {
  await revokeSessions(db, currentUser(req));
  reply.header("Set-Cookie", clearSessionCookieHeader());
  return { ok: true };
});
}
