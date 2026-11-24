import type { FastifyInstance } from "fastify";
import type { Db } from "@localmeals/db";
import { runWithRequestActorStore, setRequestActor } from "./requestActor.js";
import {
  getSessionUserFromRequestAsync,
  requireKitchenStaff,
  requireRole,
  type AuthRole,
  type SessionUser,
} from "../services/auth.js";
import { findCookById, getOrderByPublicId } from "../services/orders.js";

export type AuthedReq = {
  headers: Record<string, string | string[] | undefined>;
  sessionUser?: SessionUser | null;
};

/** Attach session user on every request (cookie / Bearer). */
export function registerSessionHook(app: FastifyInstance, db: Db) {
  app.addHook("onRequest", (_req, _reply, done) => {
    runWithRequestActorStore(done);
  });
  app.addHook("preHandler", async (req) => {
    const authed = req as unknown as AuthedReq;
    authed.sessionUser = await getSessionUserFromRequestAsync(db, req.headers);
    if (authed.sessionUser?.role === "ADMIN" && authed.sessionUser.mobile) {
      setRequestActor(authed.sessionUser.mobile);
    }
  });
}

export function currentUser(req: AuthedReq): SessionUser | null {
  return req.sessionUser ?? null;
}

/**
 * Always require a signed-in user with one of `roles`.
 * Not gated by AUTH_ENFORCE — admin/internal must never soft-open in staging.
 */
export function assertAuthed(req: AuthedReq, roles: AuthRole[]) {
  return requireRole(currentUser(req), roles);
}

/** Always require COOK (this slug) or ADMIN — kitchen mutators / desk data. */
export function assertKitchenStaff(req: AuthedReq, slug: string): SessionUser {
  return requireKitchenStaff(currentUser(req), slug);
}

export async function assertOrderKitchenStaff(db: Db, req: AuthedReq, publicId: string) {
  const order = await getOrderByPublicId(db, publicId);
  if (!order) throw new Error("Order not found");
  const cook = await findCookById(db, order.cookId);
  if (!cook) throw new Error("Kitchen not found");
  assertKitchenStaff(req, cook.slugHandle);
  return { order, cook };
}

/**
 * HTTP order creates always bind to the signed-in CUSTOMER mobile.
 * Body `customerMobile` is ignored for customers (anti-spoof). Soft AUTH_ENFORCE
 * no longer allows anonymous / cook / admin to invent a customer mobile on HTTP.
 */
export function bindCustomerMobile(req: AuthedReq, _customerMobile?: string): string {
  const user = requireRole(currentUser(req), ["CUSTOMER"]);
  return user.mobile;
}

export type AuthHelpers = {
  currentUser: typeof currentUser;
  assertAuthed: typeof assertAuthed;
  assertKitchenStaff: typeof assertKitchenStaff;
  assertOrderKitchenStaff: (req: AuthedReq, publicId: string) => ReturnType<typeof assertOrderKitchenStaff>;
  bindCustomerMobile: typeof bindCustomerMobile;
};

export function createAuthHelpers(db: Db): AuthHelpers {
  return {
    currentUser,
    assertAuthed,
    assertKitchenStaff,
    assertOrderKitchenStaff: (req, publicId) => assertOrderKitchenStaff(db, req, publicId),
    bindCustomerMobile,
  };
}
