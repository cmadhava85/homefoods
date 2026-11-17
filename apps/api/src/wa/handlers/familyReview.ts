import {
  parseFamilyInviteCommand,
  parseReviewCommand,
} from "@localmeals/adapters";
import { publicErrorMessage } from "../../httpErrors.js";
import type { WaSession } from "../session.js";

/** Child Pays invite/accept + post-delivery review via WhatsApp. */
export async function handleFamilyReview(s: WaSession): Promise<object> {
  const { db, from, text, intent, wa, mobile, replies } = s;
  const { waLocale } = s;

  if (intent === "FAMILY") {
    const { payerMobile } = parseFamilyInviteCommand(text);
    if (!payerMobile) {
      await wa.send({
        to: from,
        body: [
          "Child Pays — invite family to settle UPI for you.",
          "Reply: Family 9876543210",
          "They accept with: Accept family",
          "Then on kitchen cart / Order … PAY 9876543210",
        ].join("\n"),
        buttons: ["Orders", "Help", "Menu"],
      });
      return { ok: true, intent, needMobile: true, replies: replies() };
    }
    try {
      const { requestFamilyLink } = await import("../../services/family.js");
      const link = await requestFamilyLink(db, {
        seniorMobile: mobile,
        payerMobile,
      });
      await wa.send({
        to: from,
        body: [
          `Family invite sent to ${link.payerMobile}.`,
          "They should reply: Accept family",
          "When ACTIVE, use Who pays? on web or Order … PAY <their number>.",
        ].join("\n"),
        buttons: ["Orders", "Menu"],
      });
      return { ok: true, intent, linkId: link.id, replies: replies() };
    } catch (e) {
      await wa.send({
        to: from,
        body: publicErrorMessage(e, waLocale),
        buttons: ["Family", "Help"],
      });
      return { ok: true, intent, error: publicErrorMessage(e, waLocale), replies: replies() };
    }
  }

  if (intent === "FAMILY_ACCEPT") {
    try {
      const { listFamilyLinksForMobile, acceptFamilyLink } = await import(
        "../../services/family.js"
      );
      const links = await listFamilyLinksForMobile(db, mobile);
      const pending = links.find((l) => l.role === "PAYER" && l.status === "PENDING");
      if (!pending) {
        await wa.send({
          to: from,
          body: "No pending family invite on this number. Ask them to send: Family <your mobile>",
          buttons: ["Orders", "Help"],
        });
        return { ok: true, intent, empty: true, replies: replies() };
      }
      await acceptFamilyLink(db, { linkId: pending.id, payerMobile: mobile });
      await wa.send({
        to: from,
        body: `You’re linked — you’ll get Pay when they bill you (Child Pays).`,
        buttons: ["Orders", "Menu"],
      });
      return { ok: true, intent, linkId: pending.id, replies: replies() };
    } catch (e) {
      await wa.send({
        to: from,
        body: publicErrorMessage(e, waLocale),
        buttons: ["Help"],
      });
      return { ok: true, intent, error: publicErrorMessage(e, waLocale), replies: replies() };
    }
  }

  if (intent === "REVIEW") {
    const parsed = parseReviewCommand(text);
    if (!parsed.publicId || parsed.rating == null) {
      await wa.send({
        to: from,
        body: [
          "Rate a delivered order:",
          "Review LM-1234 5 tasty thali",
          "(1–5 stars; comment optional)",
        ].join("\n"),
        buttons: ["Orders", "Menu"],
      });
      return { ok: true, intent, needArgs: true, replies: replies() };
    }
    try {
      const { createReviewForOrder } = await import("../../services/reviews.js");
      const review = await createReviewForOrder(db, {
        publicId: parsed.publicId,
        customerMobile: mobile,
        rating: parsed.rating,
        comment: parsed.comment ?? null,
      });
      await wa.send({
        to: from,
        body: `Thanks — ★${review.rating} saved for ${review.orderPublicId}.`,
        buttons: ["Orders", "Menu"],
      });
      return { ok: true, intent, reviewId: review.id, replies: replies() };
    } catch (e) {
      await wa.send({
        to: from,
        body: publicErrorMessage(e, waLocale),
        buttons: ["Orders", "Help"],
      });
      return { ok: true, intent, error: publicErrorMessage(e, waLocale), replies: replies() };
    }
  }

  await wa.send({ to: from, body: "Try Family, Accept family, or Review LM-… 5 …", buttons: ["Help"] });
  return { ok: true, intent, replies: replies() };
}
