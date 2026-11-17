/** Soft-launch: hide public aggregate until this many reviews exist. */
export const REVIEW_PUBLIC_MIN_COUNT = 3;

export const REVIEW_COMMENT_MAX = 500;
export const COOK_REPLY_MAX = 500;

const REVIEWABLE_STATUSES = new Set(["DELIVERED"]);

export function isOrderReviewable(status: string): boolean {
  return REVIEWABLE_STATUSES.has(status);
}

export function assertValidRating(rating: number): void {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("Rating must be a whole number from 1 to 5");
  }
}

export function normalizeReviewComment(comment: string | null | undefined): string | null {
  if (comment == null) return null;
  const trimmed = comment.trim();
  if (!trimmed) return null;
  if (trimmed.length > REVIEW_COMMENT_MAX) {
    throw new Error(`Comment must be at most ${REVIEW_COMMENT_MAX} characters`);
  }
  return trimmed;
}

export function normalizeCookReply(reply: string): string {
  const trimmed = reply.trim();
  if (!trimmed) throw new Error("Reply cannot be empty");
  if (trimmed.length > COOK_REPLY_MAX) {
    throw new Error(`Reply must be at most ${COOK_REPLY_MAX} characters`);
  }
  return trimmed;
}

export function isReviewAggregatePublic(reviewCount: number, min = REVIEW_PUBLIC_MIN_COUNT): boolean {
  return reviewCount >= min;
}

export function averageRating(ratings: number[]): number | null {
  if (!ratings.length) return null;
  const sum = ratings.reduce((a, b) => a + b, 0);
  return Math.round((sum / ratings.length) * 10) / 10;
}

/** Public display: last 4 digits only. */
export function maskMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, "");
  const last4 = digits.slice(-4) || "****";
  return `····${last4}`;
}
