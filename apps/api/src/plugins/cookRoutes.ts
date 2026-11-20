import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@localmeals/db";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";

import {
  listPendingCancelRequests,
  listPendingLateOrders,
} from "../services/orders.js";
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

const mealTypeSchema = z.enum(["BREAKFAST", "LUNCH", "DINNER"]);

export async function cookRoutes(
  app: FastifyInstance,
  opts: { db: Db,
  auth: AuthHelpers },
) {
  const { db, auth } = opts;
  const { currentUser, assertAuthed, assertKitchenStaff, assertOrderKitchenStaff, bindCustomerMobile } = auth;
app.get("/cooks/:slug/reviews", async (req, reply) => {
  const { slug } = req.params as { slug: string };
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

app.post("/cooks/:slug/reviews/:reviewId/reply", async (req, reply) => {
  const { slug, reviewId } = req.params as { slug: string; reviewId: string };
  const body = z.object({ reply: z.string().min(1).max(500) }).parse(req.body ?? {});
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
  const { slug } = req.params as { slug: string };
  const q = req.query as { date?: string; meal?: string };
  const meal = mealTypeSchema.safeParse((q.meal ?? "LUNCH").toUpperCase());
  try {
    assertKitchenStaff(req, slug);
    return await getManifest(db, slug, q.date, meal.success ? meal.data : "LUNCH");
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/whatsapp-feed", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  try {
    assertKitchenStaff(req, slug);
    return await getCookWhatsAppFeed(db, slug);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/meal-settings", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  try {
    assertKitchenStaff(req, slug);
    return await getCookMealSettings(db, slug);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/meal-settings/:mealType", async (req, reply) => {
  const { slug, mealType: raw } = req.params as { slug: string; mealType: string };
  const mealType = mealTypeSchema.parse(raw.toUpperCase());
  const body = z
    .object({
      enabled: z.boolean().optional(),
      cutoffHour: z.number().int().min(0).max(23).optional(),
      cutoffMinute: z.number().int().min(0).max(59).optional(),
      deliveryWindow: z
        .object({
          startHour: z.number().int().min(0).max(23),
          startMinute: z.number().int().min(0).max(59).default(0),
          endHour: z.number().int().min(0).max(23),
          endMinute: z.number().int().min(0).max(59).default(0),
        })
        .optional(),
    })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await updateCookMealSettings(db, slug, mealType, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/week-discount", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z
    .object({
      percent: z.number().int().min(0).max(15),
      minDays: z.number().int().min(2).max(14).default(3),
    })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await setCookWeekDiscount(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/pickup", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z
    .object({
      pickupEnabled: z.boolean().optional(),
      pickupLandmark: z.string().max(300).nullable().optional(),
    })
    .refine((b) => b.pickupEnabled !== undefined || b.pickupLandmark !== undefined, {
      message: "pickupEnabled or pickupLandmark required",
    })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await setCookPickupSettings(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/intake-pause", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z.object({ paused: z.boolean() }).parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await setCookIntakePause(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/cooks/:slug/fulfillment", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z
    .object({
      cookDelivery: z.boolean().optional(),
      customerArrange: z.boolean().optional(),
      pickupEnabled: z.boolean().optional(),
      pickupLandmark: z.string().max(300).nullable().optional(),
    })
    .refine(
      (b) =>
        b.cookDelivery !== undefined ||
        b.customerArrange !== undefined ||
        b.pickupEnabled !== undefined ||
        b.pickupLandmark !== undefined,
      { message: "At least one fulfillment field required" },
    )
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await setCookFulfillmentOffers(db, slug, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/menu", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const q = req.query as { date?: string; view?: "day" | "week"; meal?: string };
  const meal = mealTypeSchema.safeParse((q.meal ?? "LUNCH").toUpperCase());
  try {
    assertKitchenStaff(req, slug);
    return await listCookDailyMenu(db, slug, {
      serviceDate: q.date,
      view: q.view === "week" ? "week" : "day",
      mealType: meal.success ? meal.data : "LUNCH",
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/menu", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z
    .object({
      itemName: z.string().min(1).max(100),
      itemNameTa: z.string().max(100).nullable().optional(),
      priceRupees: z.number().positive().optional(),
      pricePaise: z.number().int().positive().optional(),
      isVeg: z.boolean().optional(),
      allergens: z.array(z.string()).optional(),
      totalStockAvailable: z.number().int().optional(),
      /** Calendar day; omit for today. Pass null with dayOfWeek for weekly. */
      serviceDate: z.string().nullable().optional(),
      dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
      weekly: z.boolean().optional(),
      imageUrl: z.string().nullable().optional(),
      mealType: z.enum(["BREAKFAST", "LUNCH", "DINNER"]).optional(),
      saveToLibrary: z.boolean().optional(),
    })
    .refine((b) => b.pricePaise != null || b.priceRupees != null, {
      message: "priceRupees or pricePaise required",
    })
    .parse(req.body);
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
  const { slug } = req.params as { slug: string };
  const q = req.query as { meal?: string };
  const meal = mealTypeSchema.safeParse((q.meal ?? "LUNCH").toUpperCase());
  try {
    assertKitchenStaff(req, slug);
    return await listCookSavedPlates(db, slug, meal.success ? meal.data : "LUNCH");
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/saved-plates", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z
    .object({
      itemName: z.string().min(1).max(100).optional(),
      itemNameTa: z.string().max(100).nullable().optional(),
      priceRupees: z.number().positive().optional(),
      pricePaise: z.number().int().positive().optional(),
      isVeg: z.boolean().optional(),
      imageUrl: z.string().nullable().optional(),
      mealType: mealTypeSchema.optional(),
      fromMenuId: z.number().int().optional(),
    })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    const row = await saveCookSavedPlate(db, slug, body);
    return reply.code(201).send(row);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.delete("/cooks/:slug/saved-plates/:id", async (req, reply) => {
  const { slug, id } = req.params as { slug: string; id: string };
  try {
    assertKitchenStaff(req, slug);
    return await deleteCookSavedPlate(db, slug, Number(id));
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/saved-plates/:id/post", async (req, reply) => {
  const { slug, id } = req.params as { slug: string; id: string };
  const body = z
    .object({
      serviceDate: z.string().nullable().optional(),
      weekly: z.boolean().optional(),
      dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    const item = await postCookSavedPlate(db, slug, Number(id), body);
    return reply.code(201).send(item);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/menu-templates", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const q = req.query as { meal?: string };
  const meal = mealTypeSchema.safeParse((q.meal ?? "LUNCH").toUpperCase());
  try {
    assertKitchenStaff(req, slug);
    return await listCookMenuTemplates(db, slug, meal.success ? meal.data : "LUNCH");
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/menu-templates", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z
    .object({
      name: z.string().min(2).max(80),
      mealType: mealTypeSchema.optional(),
      fromServiceDate: z.string().nullable().optional(),
      items: z
        .array(
          z.object({
            itemName: z.string().min(1).max(100),
            itemNameTa: z.string().max(100).nullable().optional(),
            pricePaise: z.number().int().positive(),
            isVeg: z.boolean().optional(),
            imageUrl: z.string().nullable().optional(),
          }),
        )
        .optional(),
    })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    const row = await saveCookMenuTemplate(db, slug, body);
    return reply.code(201).send(row);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.delete("/cooks/:slug/menu-templates/:id", async (req, reply) => {
  const { slug, id } = req.params as { slug: string; id: string };
  try {
    assertKitchenStaff(req, slug);
    return await deleteCookMenuTemplate(db, slug, Number(id));
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/menu-templates/:id/post", async (req, reply) => {
  const { slug, id } = req.params as { slug: string; id: string };
  const body = z
    .object({
      serviceDate: z.string().nullable().optional(),
      weekly: z.boolean().optional(),
      dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    const result = await postCookMenuTemplate(db, slug, Number(id), body);
    return reply.code(201).send(result);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/menu/photo", async (req, reply) => {
  const { slug } = req.params as { slug: string };
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
  const { slug, id } = req.params as { slug: string; id: string };
  const body = z
    .object({
      itemName: z.string().min(1).max(100).optional(),
      itemNameTa: z.string().max(100).nullable().optional(),
      priceRupees: z.number().positive().optional(),
      pricePaise: z.number().int().positive().optional(),
      isVeg: z.boolean().optional(),
      allergens: z.array(z.string()).optional(),
      totalStockAvailable: z.number().int().optional(),
      isAvailable: z.boolean().optional(),
      imageUrl: z.string().nullable().optional(),
      dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
      serviceDate: z.string().nullable().optional(),
    })
    .parse(req.body);
  try {
    assertKitchenStaff(req, slug);
    return await updateCookMenuItem(db, slug, Number(id), body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.delete("/cooks/:slug/menu/:id", async (req, reply) => {
  const { slug, id } = req.params as { slug: string; id: string };
  try {
    assertKitchenStaff(req, slug);
    return await deleteCookMenuItem(db, slug, Number(id));
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/late-pending", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const q = req.query as { date?: string };
  try {
    assertKitchenStaff(req, slug);
    return await listPendingLateOrders(db, slug, q.date);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/cooks/:slug/cancel-pending", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const q = req.query as { date?: string };
  try {
    assertKitchenStaff(req, slug);
    return await listPendingCancelRequests(db, slug, q.date);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/cooking", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z
    .object({ mealType: mealTypeSchema.optional(), serviceDate: z.string().optional() })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await markStartCooking(db, slug, body.serviceDate, body.mealType ?? "LUNCH");
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/pack", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z
    .object({ mealType: mealTypeSchema.optional(), serviceDate: z.string().optional() })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await markPacked(db, slug, body.serviceDate, body.mealType ?? "LUNCH");
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/cooks/:slug/dispatch", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const body = z
    .object({ mealType: mealTypeSchema.optional(), serviceDate: z.string().optional() })
    .parse(req.body ?? {});
  try {
    assertKitchenStaff(req, slug);
    return await markDispatched(db, slug, body.serviceDate, body.mealType ?? "LUNCH");
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/cooking", async (req, reply) => {
  const { publicId } = req.params as { publicId: string };
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
  const { publicId } = req.params as { publicId: string };
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
  const { publicId } = req.params as { publicId: string };
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
  const { publicId } = req.params as { publicId: string };
  try {
    const { cook } = await assertOrderKitchenStaff(req, publicId);
    const { markPartnerRiderAssigned } = await import("../services/cookOps.js");
    return await markPartnerRiderAssigned(db, publicId, cook.id);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/delivered", async (req, reply) => {
  const { publicId } = req.params as { publicId: string };
  try {
    await assertOrderKitchenStaff(req, publicId);
    return await markDelivered(db, publicId);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});
}
