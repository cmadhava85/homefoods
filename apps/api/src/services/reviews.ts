import { and, desc, eq, inArray } from "drizzle-orm";
import { orders, ratingsReviews, type Db } from "@localmeals/db";
import {
  assertValidRating,
  averageRating,
  isOrderReviewable,
  isReviewAggregatePublic,
  maskMobile,
  normalizeCookReply,
  normalizeReviewComment,
} from "@localmeals/domain";

export type ReviewSummary = {
  count: number;
  average: number | null;
  public: boolean;
};

function toPublicReview(row: typeof ratingsReviews.$inferSelect) {
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    cookReply: row.cookReply,
    cookRepliedAt: row.cookRepliedAt,
    createdAt: row.createdAt,
    customerLabel: maskMobile(row.customerMobile),
  };
}

export async function getCookReviewSummary(db: Db, cookId: string): Promise<ReviewSummary> {
  const rows = await db
    .select({ rating: ratingsReviews.rating })
    .from(ratingsReviews)
    .where(eq(ratingsReviews.cookId, cookId));
  const ratings = rows.map((r) => r.rating);
  const count = ratings.length;
  return {
    count,
    average: averageRating(ratings),
    public: isReviewAggregatePublic(count),
  };
}

export async function listPublicKitchenReviews(db: Db, slug: string, limit = 20) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, slug),
  });
  if (!cook) return null;

  const { getFeatureFlags } = await import("./featureFlags.js");
  const flags = await getFeatureFlags(db);
  if (!flags.reviews_enabled) {
    return {
      cook: { id: cook.id, kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
      summary: { count: 0, average: null, public: false },
      reviews: [],
    };
  }

  const rows = await db.query.ratingsReviews.findMany({
    where: (t, { eq: e }) => e(t.cookId, cook.id),
    orderBy: (t, { desc: d }) => [d(t.createdAt)],
    limit: Math.min(limit, 50),
  });
  const summary = await getCookReviewSummary(db, cook.id);

  return {
    cook: { id: cook.id, kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
    summary,
    /** Comments/stars list only once soft-launch threshold is met. */
    reviews: summary.public ? rows.map(toPublicReview) : [],
  };
}

export async function listCookReviewsForDesk(db: Db, slug: string, limit = 40) {
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, slug),
  });
  if (!cook) return null;

  const rows = await db
    .select({
      id: ratingsReviews.id,
      rating: ratingsReviews.rating,
      comment: ratingsReviews.comment,
      cookReply: ratingsReviews.cookReply,
      cookRepliedAt: ratingsReviews.cookRepliedAt,
      createdAt: ratingsReviews.createdAt,
      customerMobile: ratingsReviews.customerMobile,
      orderPublicId: orders.publicId,
      itemName: orders.itemName,
      serviceDate: orders.serviceDate,
    })
    .from(ratingsReviews)
    .innerJoin(orders, eq(orders.id, ratingsReviews.orderId))
    .where(eq(ratingsReviews.cookId, cook.id))
    .orderBy(desc(ratingsReviews.createdAt))
    .limit(Math.min(limit, 100));

  const summary = await getCookReviewSummary(db, cook.id);

  return {
    cook: { id: cook.id, kitchenName: cook.kitchenName, slugHandle: cook.slugHandle },
    summary,
    reviews: rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      comment: r.comment,
      cookReply: r.cookReply,
      cookRepliedAt: r.cookRepliedAt,
      createdAt: r.createdAt,
      customerLabel: maskMobile(r.customerMobile),
      orderPublicId: r.orderPublicId,
      itemName: r.itemName,
      serviceDate: r.serviceDate,
    })),
  };
}

export async function findReviewForOrder(db: Db, orderId: number) {
  return db.query.ratingsReviews.findFirst({
    where: (t, { eq: e }) => e(t.orderId, orderId),
  });
}

export async function createReviewForOrder(
  db: Db,
  input: {
    publicId: string;
    customerMobile: string;
    rating: number;
    comment?: string | null;
  },
) {
  const { assertFeatureEnabled } = await import("./featureFlags.js");
  await assertFeatureEnabled(db, "reviews_enabled", "Reviews are temporarily paused");
  assertValidRating(input.rating);
  const comment = normalizeReviewComment(input.comment);

  const order = await db.query.orders.findFirst({
    where: (t, { eq: e }) => e(t.publicId, input.publicId),
  });
  if (!order) throw new Error("Order not found");
  if (order.customerMobile !== input.customerMobile) {
    throw new Error("Only the customer who placed this order can review");
  }
  if (!isOrderReviewable(order.status)) {
    throw new Error("You can review only after the order is delivered");
  }

  const existing = await findReviewForOrder(db, order.id);
  if (existing) throw new Error("You already reviewed this order");

  const [row] = await db
    .insert(ratingsReviews)
    .values({
      orderId: order.id,
      cookId: order.cookId,
      customerMobile: order.customerMobile,
      rating: input.rating,
      comment,
    })
    .returning();

  return {
    id: row.id,
    orderPublicId: order.publicId,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.createdAt,
  };
}

export async function replyToReview(
  db: Db,
  input: { slug: string; reviewId: number; cookMobile: string; reply: string },
) {
  const reply = normalizeCookReply(input.reply);
  const cook = await db.query.cookProfiles.findFirst({
    where: (t, { eq: e }) => e(t.slugHandle, input.slug),
  });
  if (!cook) throw new Error("Kitchen not found");
  if (cook.mobileNumber !== input.cookMobile) {
    throw new Error("Only this kitchen’s cook can reply");
  }

  const review = await db.query.ratingsReviews.findFirst({
    where: (t, { eq: e }) => e(t.id, input.reviewId),
  });
  if (!review || review.cookId !== cook.id) throw new Error("Review not found");

  const [updated] = await db
    .update(ratingsReviews)
    .set({ cookReply: reply, cookRepliedAt: new Date() })
    .where(and(eq(ratingsReviews.id, review.id), eq(ratingsReviews.cookId, cook.id)))
    .returning();

  return toPublicReview(updated);
}

/** Attach review eligibility to customer order list rows. */
export async function reviewFlagsForOrders(
  db: Db,
  orderRows: Array<{ id: number; status: string }>,
) {
  if (!orderRows.length) return new Map<number, { canReview: boolean; hasReview: boolean }>();
  const ids = orderRows.map((o) => o.id);
  const existing = await db
    .select({ orderId: ratingsReviews.orderId })
    .from(ratingsReviews)
    .where(inArray(ratingsReviews.orderId, ids));
  const has = new Set(existing.map((e) => e.orderId));
  const map = new Map<number, { canReview: boolean; hasReview: boolean }>();
  for (const o of orderRows) {
    const hasReview = has.has(o.id);
    map.set(o.id, {
      hasReview,
      canReview: isOrderReviewable(o.status) && !hasReview,
    });
  }
  return map;
}
