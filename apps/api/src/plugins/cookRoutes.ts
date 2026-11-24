import type { FastifyInstance } from "fastify";
import type { Db } from "@localmeals/db";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";

import {
  listPendingCancelRequests,
  listPendingLateOrders,
} from "../services/orders.js";
import { createCookTicket } from "../services/admin.js";
import {
  addCookMenuItem,
  advanceOrderKitchenStatus,
  getCookMealSettings,
  getCookWhatsAppFeed,
  getManifest,
  listCookDailyMenu,
  markDelivered,
  markDispatched,
  markPacked,
  markStartCooking,
  setCookPickupSettings,
  setCookWeekDiscount,
  updateCookMealSettings,
  updateCookMenuItem,
  deleteCookMenuItem,
  listCookSavedPlates,
  saveCookSavedPlate,
  deleteCookSavedPlate,
  postCookSavedPlate,
  setCookIntakePause,
  setCookLateOrders,
  trimCookRemainingPlates,
  getCookCapacityToday,
  listCookUpcomingOrders,
  setCookFulfillmentOffers,
  listCookMenuTemplates,
  saveCookMenuTemplate,
  deleteCookMenuTemplate,
  postCookMenuTemplate,
} from "../services/cookOps.js";
import {
  listCookReviewsForDesk,
  replyToReview,
} from "../services/reviews.js";
import { saveMenuImage } from "../uploads.js";
import { REVIEW_PUBLIC_MIN_COUNT } from "@localmeals/domain";
import { MealType } from "../openapi/shared.js";
import {
  AdsBoostBody,
  CapacityTrimBody,
  DateQuery,
  FulfillmentBody,
  IntakePauseBody,
  KitchenBatchBody,
  LateOrdersBody,
  ManifestQuery,
  MealQueryOnly,
  MealSettingsParams,
  MealSettingsPatchBody,
  MenuItemCreateBody,
  MenuItemPatchBody,
  MenuQuery,
  MenuTemplateCreateBody,
  OrderParams,
  PickupBody,
  PostPlatesBody,
  ReviewReplyBody,
  ReviewReplyParams,
  SavedPlateCreateBody,
  SlugIdParams,
  SlugParams,
  UpcomingOrdersQuery,
  WeekDiscountBody,
  CookTicketBody,
} from "./cookRoutes.contract.js";

/** Case-insensitive meal query; unknown values fall back to LUNCH (lenient desk links). */
function mealFromQuery(raw: string | undefined) {
  const meal = MealType.safeParse((raw ?? "LUNCH").toUpperCase());
  return meal.success ? meal.data : "LUNCH";
}

export async function cookRoutes(
  app: FastifyInstance,
  opts: { db: Db,
  auth: AuthHelpers },
) {
  const { db, auth } = opts;
  const { currentUser, assertAuthed, assertKitchenStaff, assertOrderKitchenStaff, bindCustomerMobile } = auth;
app.get("/cooks/:slug/reviews", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  try {
    assertKitchenStaff(req, slug);
    const data = await listCookReviewsForDesk(db, slug);
    if (!data) return reply.code(404).send({ error: "Kitchen not found" });
    return {
      ...data,
      softLaunchMin: REVIEW_PUBLIC_MIN_COUNT,
    };
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/tickets", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = CookTicketBody.parse(req.body ?? {});
  try {
    const user = assertKitchenStaff(req, slug);
    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.slugHandle, slug),
    });
    if (!cook) return reply.code(404).send({ error: "Kitchen not found" });
    const ticket = await createCookTicket(db, {
      cookId: cook.id,
      cookMobile: user.role === "COOK" ? user.mobile : cook.mobileNumber,
      summary: body.summary,
      category: body.category,
      orderPublicId: body.orderPublicId,
    });
    return { ok: true as const, ticketId: ticket.id, status: ticket.status, source: ticket.source };
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/reviews/:reviewId/reply", async (req, reply) => {
  const { slug, reviewId } = ReviewReplyParams.parse(req.params);
  const body = ReviewReplyBody.parse(req.body ?? {});
  try {
    const user = assertKitchenStaff(req, slug);
    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.slugHandle, slug),
    });
    if (!cook) return reply.code(404).send({ error: "Kitchen not found" });
    // ADMIN acting as kitchen staff uses the cook's mobile for ownership checks.
    return await replyToReview(db, {
      slug,
      reviewId: Number(reviewId),
      cookMobile: user.role === "COOK" ? user.mobile : cook.mobileNumber,
      reply: body.reply,
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/manifest", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const q = ManifestQuery.parse(req.query ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await getManifest(db, slug, q.date, mealFromQuery(q.meal));
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/upcoming-orders", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const q = UpcomingOrdersQuery.safeParse(req.query ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await listCookUpcomingOrders(db, slug, {
      days: q.success ? q.data.days : 7,
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/ads", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  try {
    assertKitchenStaff(req, slug);
    const { listCookBoostCampaigns } = await import("../services/ads.js");
    return await listCookBoostCampaigns(db, slug);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/ads/boost", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = AdsBoostBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    const { requestCookKitchenBoost } = await import("../services/ads.js");
    return await requestCookKitchenBoost(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/whatsapp-feed", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  try {
    assertKitchenStaff(req, slug);
    return await getCookWhatsAppFeed(db, slug);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/meal-settings", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  try {
    assertKitchenStaff(req, slug);
    return await getCookMealSettings(db, slug);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/meal-settings/:mealType", async (req, reply) => {
  const { slug, mealType: raw } = MealSettingsParams.parse(req.params);
  const mealType = MealType.parse(raw.toUpperCase());
  const body = MealSettingsPatchBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await updateCookMealSettings(db, slug, mealType, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/week-discount", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = WeekDiscountBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await setCookWeekDiscount(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/pickup", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = PickupBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await setCookPickupSettings(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/intake-pause", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = IntakePauseBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await setCookIntakePause(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/late-orders", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = LateOrdersBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await setCookLateOrders(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/capacity-today", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  try {
    assertKitchenStaff(req, slug);
    return await getCookCapacityToday(db, slug);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/capacity-today", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = CapacityTrimBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await trimCookRemainingPlates(db, slug, body.remaining);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/fulfillment", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = FulfillmentBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await setCookFulfillmentOffers(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/menu", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const q = MenuQuery.parse(req.query ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await listCookDailyMenu(db, slug, {
      serviceDate: q.date,
      view: q.view === "week" ? "week" : "day",
      mealType: mealFromQuery(q.meal),
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/menu", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = MenuItemCreateBody.parse(req.body);
  try {
    assertKitchenStaff(req, slug);
    const weekly = body.weekly || (body.dayOfWeek != null && body.serviceDate === null);
    const item = await addCookMenuItem(db, slug, {
      ...body,
      serviceDate: weekly ? null : body.serviceDate === undefined ? undefined : body.serviceDate,
      dayOfWeek: body.dayOfWeek,
      saveToLibrary: body.saveToLibrary ?? true,
    });
    return reply.code(201).send(item);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/saved-plates", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const q = MealQueryOnly.parse(req.query ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await listCookSavedPlates(db, slug, mealFromQuery(q.meal));
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/saved-plates", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = SavedPlateCreateBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    const row = await saveCookSavedPlate(db, slug, body);
    return reply.code(201).send(row);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.delete("/cooks/:slug/saved-plates/:id", async (req, reply) => {
  const { slug, id } = SlugIdParams.parse(req.params);
  try {
    assertKitchenStaff(req, slug);
    return await deleteCookSavedPlate(db, slug, Number(id));
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/saved-plates/:id/post", async (req, reply) => {
  const { slug, id } = SlugIdParams.parse(req.params);
  const body = PostPlatesBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    const item = await postCookSavedPlate(db, slug, Number(id), body);
    return reply.code(201).send(item);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/menu-templates", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const q = MealQueryOnly.parse(req.query ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await listCookMenuTemplates(db, slug, mealFromQuery(q.meal));
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/menu-templates", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = MenuTemplateCreateBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    const row = await saveCookMenuTemplate(db, slug, body);
    return reply.code(201).send(row);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.delete("/cooks/:slug/menu-templates/:id", async (req, reply) => {
  const { slug, id } = SlugIdParams.parse(req.params);
  try {
    assertKitchenStaff(req, slug);
    return await deleteCookMenuTemplate(db, slug, Number(id));
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/menu-templates/:id/post", async (req, reply) => {
  const { slug, id } = SlugIdParams.parse(req.params);
  const body = PostPlatesBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    const result = await postCookMenuTemplate(db, slug, Number(id), body);
    return reply.code(201).send(result);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/menu/photo", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  try {
    assertKitchenStaff(req, slug);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "photo file required" });
    const url = await saveMenuImage(file);
    return { url };
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/menu/:id", async (req, reply) => {
  const { slug, id } = SlugIdParams.parse(req.params);
  const body = MenuItemPatchBody.parse(req.body);
  try {
    assertKitchenStaff(req, slug);
    return await updateCookMenuItem(db, slug, Number(id), body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.delete("/cooks/:slug/menu/:id", async (req, reply) => {
  const { slug, id } = SlugIdParams.parse(req.params);
  try {
    assertKitchenStaff(req, slug);
    return await deleteCookMenuItem(db, slug, Number(id));
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/late-pending", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const q = DateQuery.parse(req.query ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await listPendingLateOrders(db, slug, q.date);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/cancel-pending", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const q = DateQuery.parse(req.query ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await listPendingCancelRequests(db, slug, q.date);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/cooking", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = KitchenBatchBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await markStartCooking(db, slug, body.serviceDate, body.mealType ?? "LUNCH");
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/pack", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = KitchenBatchBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await markPacked(db, slug, body.serviceDate, body.mealType ?? "LUNCH");
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/dispatch", async (req, reply) => {
  const { slug } = SlugParams.parse(req.params);
  const body = KitchenBatchBody.parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await markDispatched(db, slug, body.serviceDate, body.mealType ?? "LUNCH");
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/cooking", async (req, reply) => {
  const { publicId } = OrderParams.parse(req.params);
  try {
    await assertOrderKitchenStaff(req, publicId);
    return await advanceOrderKitchenStatus(db, publicId, "COOKING", {
      channel: "WEB_STOREFRONT",
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/pack", async (req, reply) => {
  const { publicId } = OrderParams.parse(req.params);
  try {
    await assertOrderKitchenStaff(req, publicId);
    return await advanceOrderKitchenStatus(db, publicId, "PACKED", {
      channel: "WEB_STOREFRONT",
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/dispatch", async (req, reply) => {
  const { publicId } = OrderParams.parse(req.params);
  try {
    await assertOrderKitchenStaff(req, publicId);
    return await advanceOrderKitchenStatus(db, publicId, "DISPATCHED", {
      channel: "WEB_STOREFRONT",
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

/** Partner mock / ops: ASSIGNING_RIDER → DISPATCHED when rider is found. */
app.post("/orders/:publicId/rider-assigned", async (req, reply) => {
  const { publicId } = OrderParams.parse(req.params);
  try {
    const { cook } = await assertOrderKitchenStaff(req, publicId);
    const { markPartnerRiderAssigned } = await import("../services/cookOps.js");
    return await markPartnerRiderAssigned(db, publicId, cook.id);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/delivered", async (req, reply) => {
  const { publicId } = OrderParams.parse(req.params);
  try {
    await assertOrderKitchenStaff(req, publicId);
    return await markDelivered(db, publicId);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});
}
