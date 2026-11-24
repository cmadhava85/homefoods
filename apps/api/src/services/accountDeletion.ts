import { randomBytes } from "node:crypto";
import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import {
  addresses,
  adminActionLog,
  authOtps,
  cookProfiles,
  customerCredits,
  orders,
  platformEventLedger,
  ratingsReviews,
  supportTickets,
  users,
  waCheckoutSessions,
  waInboundDedupe,
  type Db,
} from "@localmeals/db";
import { DomainError } from "@localmeals/domain";
import { revokeSessions } from "./auth.js";

/** Orders in these states are finished; anything else blocks deletion (refund/delivery pending). */
const SETTLED_STATUSES = ["DELIVERED", "CANCELLED", "REFUNDED", "FAILED"] as const;

export const DELETED_USER_NAME = "Deleted user";
export const REDACTED_ADDRESS = "[deleted]";

/** 15 chars (fits varchar(15)), never a valid +91 mobile, unique per deletion. */
function tombstoneMobile() {
  return `x${randomBytes(7).toString("hex")}`;
}

/**
 * DPDP Act 2023 §12 erasure for a CUSTOMER.
 *
 * Orders, payments and reviews must be kept for tax/accounting and dispute handling, so they are
 * re-pointed to an anonymous tombstone user and their address/route fields are redacted. Everything
 * else tied to the mobile (profile, saved addresses, subscriptions, family links, follows, OTPs,
 * WhatsApp sessions) is deleted, and all existing sessions are revoked.
 */
export async function deleteCustomerAccount(db: Db, mobile: string) {
  const cook = await db.query.cookProfiles.findFirst({
    where: eq(cookProfiles.mobileNumber, mobile),
    columns: { id: true },
  });
  if (cook) {
    throw DomainError.conflict(
      "This number runs a kitchen. Contact support to close the kitchen before deleting the account.",
    );
  }

  const active = await db
    .select({ publicId: orders.publicId, status: orders.status })
    .from(orders)
    .where(
      and(
        or(eq(orders.customerMobile, mobile), eq(orders.payerMobile, mobile)),
        notInArray(orders.status, [...SETTLED_STATUSES]),
      ),
    )
    .limit(20);
  if (active.length > 0) {
    throw DomainError.conflict(
      `You have ${active.length} order(s) still in progress (${active
        .map((o) => o.publicId)
        .join(", ")}). Cancel them or wait until they are delivered/refunded, then try again.`,
    );
  }

  const { creditBalancePaise } = await import("./credits.js");
  const credit = await creditBalancePaise(db, mobile);
  if (credit > 0) {
    throw DomainError.conflict(
      `You have ₹${(credit / 100).toFixed(2)} LocalMeals credit. Use it, or contact support to have it refunded to your bank, before deleting the account.`,
    );
  }

  const user = await db.query.users.findFirst({ where: eq(users.mobileNumber, mobile) });
  const tomb = tombstoneMobile();

  const counts = await db.transaction(async (tx) => {
    await tx.insert(users).values({
      mobileNumber: tomb,
      fullName: DELETED_USER_NAME,
      primaryAddress: "",
      preferredLanguage: user?.preferredLanguage ?? "en",
      consents: { deletedAt: new Date().toISOString() },
    });

    const ownOrders = await tx
      .update(orders)
      .set({
        customerMobile: tomb,
        addressId: null,
        deliveryTargetAddress: REDACTED_ADDRESS,
        routeMapsUrl: null,
        partnerTrackingUrl: null,
        updatedAt: new Date(),
      })
      .where(eq(orders.customerMobile, mobile))
      .returning({ id: orders.id });
    await tx.update(orders).set({ payerMobile: tomb }).where(eq(orders.payerMobile, mobile));
    // Saved addresses are deleted below; clear any remaining order FK to them (e.g. payer-side rows).
    await tx
      .update(orders)
      .set({ addressId: null })
      .where(
        inArray(
          orders.addressId,
          tx.select({ id: addresses.id }).from(addresses).where(eq(addresses.userMobile, mobile)),
        ),
      );

    await tx
      .update(customerCredits)
      .set({ customerMobile: tomb })
      .where(eq(customerCredits.customerMobile, mobile));
    await tx
      .update(ratingsReviews)
      .set({ customerMobile: tomb })
      .where(eq(ratingsReviews.customerMobile, mobile));
    await tx
      .update(supportTickets)
      .set({ customerMobile: null })
      .where(eq(supportTickets.customerMobile, mobile));
    await tx
      .update(platformEventLedger)
      .set({ associatedMobile: null })
      .where(eq(platformEventLedger.associatedMobile, mobile));
    await tx
      .update(waInboundDedupe)
      .set({ fromMobile: null })
      .where(eq(waInboundDedupe.fromMobile, mobile));
    await tx.delete(authOtps).where(eq(authOtps.mobileNumber, mobile));
    await tx.delete(waCheckoutSessions).where(eq(waCheckoutSessions.mobileNumber, mobile));

    // Cascades: addresses, subscriptions, family_links, kitchen_followers.
    await tx.delete(users).where(eq(users.mobileNumber, mobile));

    await tx.insert(adminActionLog).values({
      actor: "self-service",
      action: "ACCOUNT_DELETED",
      entityType: "user",
      entityId: tomb,
      reason: "Customer erasure request (DPDP)",
      payload: { anonymisedOrders: ownOrders.length },
    });
    return { anonymisedOrders: ownOrders.length };
  });

  await revokeSessions(db, { mobile, role: "CUSTOMER" });
  return { ok: true as const, ...counts };
}
