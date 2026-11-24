import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import { Id, Mobile, Ok, Role, Slug, Text, Uuid } from "../openapi/shared.js";

export const OtpRequestBody = z
  .object({ mobile: Mobile, role: Role })
  .describe("Request a one-time code over WhatsApp");
export const OtpVerifyBody = z
  .object({
    mobile: Mobile,
    role: Role,
    code: z.string().min(4).max(8).regex(/^\d+$/).describe("OTP digits"),
  })
  .describe("Verify a one-time code");

const SessionUser = z
  .object({
    mobile: Mobile,
    role: Role,
    fullName: Text(100),
    pinCode: z.string().max(6).optional(),
    cookSlug: Slug.optional(),
    cookId: Uuid.optional(),
  })
  .describe("Signed-in user");

const OtpRequested = z
  .object({
    ok: z.literal(true),
    mobile: Mobile,
    role: Role,
    expiresInSec: Id,
    mockCode: z.string().max(8).optional().describe("Dev/staging demo code only; never for ADMIN on production"),
  })
  .describe("Same response whether or not the number may sign in (no account enumeration)");

export const authOperations = defineOperations([
  {
    method: "post",
    path: "/auth/otp/request",
    operationId: "requestOtp",
    summary: "Send a sign-in code via WhatsApp",
    tags: ["Auth"],
    access: "public",
    body: OtpRequestBody,
    response: OtpRequested,
  },
  {
    method: "post",
    path: "/auth/otp/verify",
    operationId: "verifyOtp",
    summary: "Verify the code; sets the HttpOnly lm_session cookie",
    tags: ["Auth"],
    access: "public",
    body: OtpVerifyBody,
    response: z
      .object({
        user: SessionUser,
        expiresInSec: Id,
        token: z.string().max(4096).optional().describe("Only outside production (Bearer tooling)"),
      })
      .describe("Session"),
  },
  {
    method: "get",
    path: "/auth/me",
    operationId: "getCurrentUser",
    summary: "Current session user",
    tags: ["Auth"],
    access: "session",
    response: z.object({ user: SessionUser }),
  },
  {
    method: "post",
    path: "/auth/logout",
    operationId: "logout",
    summary: "Revoke all sessions for this user and clear the cookie",
    tags: ["Auth"],
    access: "optionalSession",
    body: z.object({}).describe("No body fields"),
    response: Ok,
  },
]);
