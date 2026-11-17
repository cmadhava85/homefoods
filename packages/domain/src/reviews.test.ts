import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertValidRating,
  averageRating,
  COOK_REPLY_MAX,
  isOrderReviewable,
  isReviewAggregatePublic,
  maskMobile,
  normalizeCookReply,
  normalizeReviewComment,
  REVIEW_COMMENT_MAX,
  REVIEW_PUBLIC_MIN_COUNT,
} from "./reviews.js";

describe("reviews domain", () => {
  it("only DELIVERED is reviewable", () => {
    assert.equal(isOrderReviewable("DELIVERED"), true);
    assert.equal(isOrderReviewable("PAID"), false);
    assert.equal(isOrderReviewable("DISPATCHED"), false);
  });

  it("validates rating 1–5", () => {
    assertValidRating(1);
    assertValidRating(5);
    assert.throws(() => assertValidRating(0), /1 to 5/);
    assert.throws(() => assertValidRating(6), /1 to 5/);
    assert.throws(() => assertValidRating(4.5), /1 to 5/);
  });

  it("trims comments and enforces length", () => {
    assert.equal(normalizeReviewComment(null), null);
    assert.equal(normalizeReviewComment("  tasty  "), "tasty");
    assert.equal(normalizeReviewComment("   "), null);
    assert.equal(normalizeReviewComment("x".repeat(REVIEW_COMMENT_MAX)), "x".repeat(REVIEW_COMMENT_MAX));
    assert.throws(
      () => normalizeReviewComment("x".repeat(REVIEW_COMMENT_MAX + 1)),
      new RegExp(`at most ${REVIEW_COMMENT_MAX}`),
    );
  });

  it("requires non-empty cook reply and enforces max", () => {
    assert.equal(normalizeCookReply(" Thanks! "), "Thanks!");
    assert.throws(() => normalizeCookReply("  "), /empty/);
    assert.equal(
      normalizeCookReply("y".repeat(COOK_REPLY_MAX)),
      "y".repeat(COOK_REPLY_MAX),
    );
    assert.throws(
      () => normalizeCookReply("y".repeat(COOK_REPLY_MAX + 1)),
      new RegExp(`at most ${COOK_REPLY_MAX}`),
    );
  });

  it("soft-launches aggregate after threshold", () => {
    assert.equal(isReviewAggregatePublic(REVIEW_PUBLIC_MIN_COUNT - 1), false);
    assert.equal(isReviewAggregatePublic(REVIEW_PUBLIC_MIN_COUNT), true);
  });

  it("averages and masks", () => {
    assert.equal(averageRating([5, 4, 5]), 4.7);
    assert.equal(averageRating([]), null);
    assert.equal(maskMobile("+919876543210"), "····3210");
    assert.equal(maskMobile("no-digits"), "····****");
  });
});
