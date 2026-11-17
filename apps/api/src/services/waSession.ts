import { eq } from "drizzle-orm";
import { waCheckoutSessions, type Db } from "@localmeals/db";

export type WaCheckoutStep =
  | "PICK_KITCHEN"
  | "PICK_ITEM"
  | "PICK_ADDRESS"
  | "AWAIT_ADDRESS"
  | "AWAIT_MENU_PHOTO";

export type WaCheckoutPayload = {
  kitchens?: Array<{ n: number; slug: string; name: string }>;
  cookSlug?: string;
  kitchenName?: string;
  items?: Array<{ n: number; menuItemId: number; name: string; pricePaise: number }>;
  itemIndex?: number;
  forceLate?: boolean;
  fulfillmentMode?: "DELIVERY" | "PICKUP";
  payerMobile?: string | null;
  /** Cook WA menu photo attach after Add. */
  menuItemId?: number;
  itemName?: string;
};

const TTL_MS = 30 * 60 * 1000; // 30 minutes

export async function getWaSession(db: Db, mobile: string) {
  const row = await db.query.waCheckoutSessions.findFirst({
    where: (t, { eq: e }) => e(t.mobileNumber, mobile),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await clearWaSession(db, mobile);
    return null;
  }
  return {
    step: row.step as WaCheckoutStep,
    payload: (row.payload ?? {}) as WaCheckoutPayload,
    expiresAt: row.expiresAt,
  };
}

export async function setWaSession(
  db: Db,
  mobile: string,
  step: WaCheckoutStep,
  payload: WaCheckoutPayload,
) {
  const expiresAt = new Date(Date.now() + TTL_MS);
  await db
    .insert(waCheckoutSessions)
    .values({
      mobileNumber: mobile,
      step,
      payload,
      expiresAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: waCheckoutSessions.mobileNumber,
      set: {
        step,
        payload,
        expiresAt,
        updatedAt: new Date(),
      },
    });
}

export async function clearWaSession(db: Db, mobile: string) {
  await db.delete(waCheckoutSessions).where(eq(waCheckoutSessions.mobileNumber, mobile));
}
