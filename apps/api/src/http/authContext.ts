import type { Db } from "@localmeals/db";
import {
  authEnforced,
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
export function registerSessionHook(app: {
  addHook: (
    name: "preHandler",
    fn: (req: AuthedReq) => Promise<void>,
  ) => void;
}, db: Db) {
  app.addHook("preHandler", async (req) => {
    req.sessionUser = await getSessionUserFromRequestAsync(db, req.headers);
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

export function bindCustomerMobile(req: AuthedReq, customerMobile: string): string {
  const user = currentUser(req);
  if (user?.role === "CUSTOMER") return user.mobile;
  if (authEnforced()) {
    requireRole(user, ["CUSTOMER"]);
  }
  return customerMobile;
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
