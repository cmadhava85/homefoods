import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "@localmeals/db";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";

import {
  approveLateOrder,
  cancelCheckout,
  acceptCancelRequest,
  cancelOrder,
  declineCancelRequest,
  listPendingCancelRequests,
  createOrder,
  createOrderBatch,
  declineLateOrder,
  getCheckoutById,
  getKitchenAdvanceMealOptions,
  getKitchenMenu,
  getKitchenWeekPlan,
  getOrderByPublicId,
  isOrderCancellable,
  isOrderCancelRequestable,
  listKitchens,
  listOrdersForCustomer,
  requestLateOrder,
  findCookById,
  pickupRevealForOrder,
  resolveCustomerPaymentUrl,
} from "../services/orders.js";
import {
  followKitchen,
  listFollowedKitchens,
  listMyKitchens,
  unfollowKitchen,
} from "../services/kitchenFollow.js";
import {
  createReviewForOrder,
  findReviewForOrder,
  listPublicKitchenReviews,
} from "../services/reviews.js";
import { createOrderConcern } from "../services/admin.js";
import { applyAsCook } from "../services/cookApply.js";
import { saveConcernImage } from "../uploads.js";
import { formatDeliveryWindowLabel, isOrderReviewable } from "@localmeals/domain";
import { requireRole } from "../services/auth.js";
import {
  assertSafeConcernPhotoUrl,
  orderAudience,
  redactOrderForAudience,
} from "../http/orderViews.js";

const mealTypeSchema = z.enum(["BREAKFAST", "LUNCH", "DINNER"]);

export async function customerRoutes(
  app: FastifyInstance,
  opts: { db: Db,
  auth: AuthHelpers },
) {
  const { db, auth } = opts;
  const { currentUser, assertAuthed, assertKitchenStaff, assertOrderKitchenStaff, bindCustomerMobile } = auth;
app.get("/kitchens", async (req) => {
  const q = req.query as { pin?: string };
  return listKitchens(db, q.pin);
});

/** Pin ads / kitchen boosts — empty when ads_enabled is off. */
app.get("/ads", async (req, reply) => {
  const q = z
    .object({ pin: z.string().regex(/^\d{6}$/) })
    .safeParse(req.query ?? {});
  if (!q.success) {
    return reply.code(400).send({ error: "pin must be 6 digits" });
  }
  try {
    const { listActiveAdsForPin } = await import("../services/ads.js");
    return await listActiveAdsForPin(db, q.data.pin);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/kitchens/:slug/menu", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const q = req.query as { date?: string; meal?: string };
  const meal = mealTypeSchema.safeParse((q.meal ?? "LUNCH").toUpperCase());
  const data = await getKitchenMenu(
    db,
    slug,
    q.date,
    meal.success ? meal.data : "LUNCH",
  );
  if (!data) return reply.code(404).send({ error: "Kitchen not found" });
  return data;
});

app.get("/kitchens/:slug/meals", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const q = req.query as { days?: string };
  const data = await getKitchenAdvanceMealOptions(db, slug, {
    days: q.days ? Number(q.days) : 7,
  });
  if (!data) return reply.code(404).send({ error: "Kitchen not found" });
  return data;
});

app.get("/kitchens/:slug/week", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const q = req.query as { from?: string; days?: string; meal?: string };
  const meal = mealTypeSchema.safeParse((q.meal ?? "LUNCH").toUpperCase());
  const data = await getKitchenWeekPlan(db, slug, {
    from: q.from,
    days: q.days ? Number(q.days) : undefined,
    mealType: meal.success ? meal.data : "LUNCH",
  });
  if (!data) return reply.code(404).send({ error: "Kitchen not found" });
  return data;
});

app.get("/me/profile", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  try {
    const { getCustomerProfile } = await import("../services/profile.js");
    return await getCustomerProfile(db, user.mobile);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/me/profile", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const body = z
    .object({
      fullName: z.string().min(2).max(80).optional(),
      pinCode: z.string().min(6).max(6).optional(),
      preferredLanguage: z.enum(["en", "ta"]).optional(),
      leanWaStatus: z.boolean().optional(),
    })
    .parse(req.body);
  try {
    const { updateCustomerProfile } = await import("../services/profile.js");
    const profile = await updateCustomerProfile(db, { mobile: user.mobile, ...body });
    return profile;
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/me/addresses", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const { listAddressesForMobile } = await import("../services/addresses.js");
  return { addresses: await listAddressesForMobile(db, user.mobile) };
});

app.post("/me/addresses", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const body = z
    .object({
      label: z.enum(["HOME", "OFFICE", "OTHER"]),
      line1: z.string().min(5),
      line2: z.string().optional().nullable(),
      pinCode: z.string().min(6).max(6),
      lat: z.union([z.string(), z.number()]).optional().nullable(),
      lng: z.union([z.string(), z.number()]).optional().nullable(),
      isDefault: z.boolean().optional(),
    })
    .parse(req.body);
  try {
    const { createAddress } = await import("../services/addresses.js");
    return await createAddress(db, { mobile: user.mobile, ...body });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.patch("/me/addresses/:id", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const { id } = req.params as { id: string };
  const body = z
    .object({
      line1: z.string().min(5).optional(),
      line2: z.string().optional().nullable(),
      pinCode: z.string().min(6).max(6).optional(),
      lat: z.union([z.string(), z.number()]).optional().nullable(),
      lng: z.union([z.string(), z.number()]).optional().nullable(),
      isDefault: z.boolean().optional(),
    })
    .parse(req.body);
  try {
    const { updateAddress } = await import("../services/addresses.js");
    return await updateAddress(db, {
      mobile: user.mobile,
      addressId: Number(id),
      ...body,
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post(
  "/orders",
  { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const body = z
      .object({
        customerMobile: z.string(),
        cookSlug: z.string(),
        menuItemId: z.number().int(),
        qty: z.number().int().min(1).default(1),
        spice: z.enum(["NORMAL", "LESS"]).default("NORMAL"),
        channel: z.enum(["WEB_STOREFRONT", "WHATSAPP_BOT"]).optional(),
        serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        fulfillmentMode: z.enum(["DELIVERY", "PICKUP", "CUSTOMER_ARRANGE"]).optional(),
        payerMobile: z.string().optional().nullable(),
        addressId: z.number().int().optional().nullable(),
      })
      .parse(req.body);
    try {
      const customerMobile = bindCustomerMobile(req, body.customerMobile);
      const rawKey = req.headers["idempotency-key"];
      const clientIdempotencyKey =
        typeof rawKey === "string" ? rawKey : Array.isArray(rawKey) ? rawKey[0] : undefined;
      return await createOrder(db, { ...body, customerMobile, clientIdempotencyKey });
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  },
);

/** Week cart: several service days, one payment. */
app.post(
  "/orders/batch",
  { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
  async (req, reply) => {
    const body = z
      .object({
        customerMobile: z.string(),
        cookSlug: z.string(),
        channel: z.enum(["WEB_STOREFRONT", "WHATSAPP_BOT"]).optional(),
        payerMobile: z.string().optional().nullable(),
        fulfillmentMode: z.enum(["DELIVERY", "PICKUP", "CUSTOMER_ARRANGE"]).optional(),
        addressId: z.number().int().optional().nullable(),
        lines: z
          .array(
            z.object({
              menuItemId: z.number().int(),
              serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              qty: z.number().int().min(1).default(1),
              spice: z.enum(["NORMAL", "LESS"]).default("NORMAL"),
            }),
          )
          .min(1)
          // Up to 14 calendar days × breakfast/lunch/dinner (matches createOrderBatch).
          .max(42),
      })
      .parse(req.body);
    try {
      const customerMobile = bindCustomerMobile(req, body.customerMobile);
      const rawKey = req.headers["idempotency-key"];
      const clientIdempotencyKey =
        typeof rawKey === "string" ? rawKey : Array.isArray(rawKey) ? rawKey[0] : undefined;
      return await createOrderBatch(db, { ...body, customerMobile, clientIdempotencyKey });
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  },
);


app.get("/family/links", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const { listFamilyLinksForMobile } = await import("../services/family.js");
  return { links: await listFamilyLinksForMobile(db, user.mobile) };
});

app.post("/family/links", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const body = z.object({ payerMobile: z.string().min(10) }).parse(req.body ?? {});
  try {
    const { requestFamilyLink } = await import("../services/family.js");
    const link = await requestFamilyLink(db, {
      seniorMobile: user.mobile,
      payerMobile: body.payerMobile,
    });
    return reply.code(201).send(link);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/family/links/:id/accept", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const { id } = req.params as { id: string };
  try {
    const { acceptFamilyLink } = await import("../services/family.js");
    return await acceptFamilyLink(db, { linkId: Number(id), payerMobile: user.mobile });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/family/links/:id/revoke", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const { id } = req.params as { id: string };
  try {
    const { revokeFamilyLink } = await import("../services/family.js");
    return await revokeFamilyLink(db, { linkId: Number(id), mobile: user.mobile });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get(
  "/checkouts/:checkoutId",
  { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
  async (req, reply) => {
  const { checkoutId } = req.params as { checkoutId: string };
  const checkout = await getCheckoutById(db, checkoutId);
  if (!checkout) return reply.code(404).send({ error: "Checkout not found" });
  const seed = checkout.orders[0];
  const session = currentUser(req);
  const audience = orderAudience(session, seed, checkout.cookSlug);
  const pendingPay =
    checkout.status === "AWAITING_PAYMENT" || checkout.status === "CONFIRMING_PAYMENT";
  const roleOnOrder =
    audience === "owner" && session
      ? checkout.payerMobile && session.mobile === checkout.payerMobile
        ? "PAYER"
        : "CUSTOMER"
      : null;
  const { partnerTrackingUrl } = await import("../services/partnerLogistics.js");
  const awaitingFamilyPay =
    pendingPay &&
    Boolean(checkout.payerMobile) &&
    roleOnOrder === "CUSTOMER" &&
    checkout.payerMobile !== checkout.customerMobile;
  return {
    checkoutId: checkout.checkoutId,
    status: checkout.status,
    gatewayTxnId: checkout.gatewayTxnId,
    paymentUrl: checkout.paymentUrl,
    totalPaise: checkout.totalPaise,
    kitchenName: checkout.kitchenName,
    cookSlug: checkout.cookSlug,
    cancellable: checkout.cancellable,
    cancelRequestable: checkout.cancelRequestable,
    roleOnOrder,
    awaitingFamilyPay,
    ...(audience === "public"
      ? {}
      : {
          customerMobile: checkout.customerMobile,
          payerMobile: checkout.payerMobile,
        }),
    orders: checkout.orders.map((o) =>
      redactOrderForAudience(o as unknown as Record<string, unknown>, audience, {
        cancellable: o.cancellable,
        cancelRequestable: o.cancelRequestable,
        lineTotalPaise: o.lineTotalPaise,
        logisticsMode: o.logisticsMode ?? "SELF",
        partnerShipmentId: o.partnerShipmentId ?? null,
        partnerTrackingUrl:
          o.logisticsMode === "PARTNER"
            ? partnerTrackingUrl(o.partnerShipmentId, o.partnerTrackingUrl)
            : null,
      }),
    ),
  };
});


/** After cut-off: request lunch — cook must accept before pay. */
app.post("/orders/late-request", async (req, reply) => {
  const body = z
    .object({
      customerMobile: z.string(),
      cookSlug: z.string(),
      menuItemId: z.number().int(),
      qty: z.number().int().min(1).default(1),
      spice: z.enum(["NORMAL", "LESS"]).default("NORMAL"),
      channel: z.enum(["WEB_STOREFRONT", "WHATSAPP_BOT"]).optional(),
      serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      addressId: z.number().int().optional().nullable(),
      fulfillmentMode: z.enum(["DELIVERY", "PICKUP", "CUSTOMER_ARRANGE"]).optional(),
      payerMobile: z.string().optional().nullable(),
    })
    .parse(req.body);
  try {
    const customerMobile = bindCustomerMobile(req, body.customerMobile);
    return await requestLateOrder(db, { ...body, customerMobile });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/late-approve", async (req, reply) => {
  const { publicId } = req.params as { publicId: string };
  try {
    await assertOrderKitchenStaff(req, publicId);
    return await approveLateOrder(db, publicId);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/late-decline", async (req, reply) => {
  const { publicId } = req.params as { publicId: string };
  const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
  try {
    await assertOrderKitchenStaff(req, publicId);
    return await declineLateOrder(db, publicId, body.reason);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/cancel-accept", async (req, reply) => {
  const { publicId } = req.params as { publicId: string };
  try {
    await assertOrderKitchenStaff(req, publicId);
    return await acceptCancelRequest(db, publicId);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/cancel-decline", async (req, reply) => {
  const { publicId } = req.params as { publicId: string };
  const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
  try {
    await assertOrderKitchenStaff(req, publicId);
    return await declineCancelRequest(db, publicId, body.reason);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/me/orders", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer to view order history" });
  }
  const q = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    })
    .parse(req.query ?? {});
  const page = await listOrdersForCustomer(db, user.mobile, {
    limit: q.limit ?? 50,
    offset: q.offset ?? 0,
  });
  return { mobile: user.mobile, ...page };
});

app.get("/me/kitchens", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const kitchens = await listMyKitchens(db, user.mobile);
  return { kitchens };
});

app.post("/me/kitchens/:slug/follow", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const { slug } = req.params as { slug: string };
  const body = z
    .object({ consent: z.boolean().optional() })
    .parse(req.body ?? {});
  try {
    return await followKitchen(db, user.mobile, slug, {
      consent: body.consent === true,
      consentVia: "web_confirm",
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/me/kitchens/:slug/unfollow", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const { slug } = req.params as { slug: string };
  try {
    return await unfollowKitchen(db, user.mobile, slug);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get(
  "/orders/:publicId",
  { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
  async (req, reply) => {
  const { publicId } = req.params as { publicId: string };
  const order = await getOrderByPublicId(db, publicId);
  if (!order) return reply.code(404).send({ error: "Not found" });
  const cook = await findCookById(db, order.cookId);
  const audience = orderAudience(currentUser(req), order, cook?.slugHandle);
  const pendingPay =
    order.status === "AWAITING_PAYMENT" || order.status === "CONFIRMING_PAYMENT";
  const existingReview = await findReviewForOrder(db, order.id);
  let deliveryWindow: string | null = null;
  if (cook) {
    const { scheduleForCook } = await import("../services/orders.js");
    const schedule = await scheduleForCook(
      db,
      cook,
      (order.mealType as "BREAKFAST" | "LUNCH" | "DINNER") || "LUNCH",
    );
    deliveryWindow = formatDeliveryWindowLabel(schedule.deliveryWindow);
  }
  const { partnerTrackingUrl } = await import("../services/partnerLogistics.js");
  const session = currentUser(req);
  const roleOnOrder =
    audience === "owner" && session
      ? order.payerMobile && session.mobile === order.payerMobile
        ? "PAYER"
        : "CUSTOMER"
      : null;
  const extras: Record<string, unknown> = {
    kitchenName: cook?.kitchenName ?? null,
    cookSlug: cook?.slugHandle ?? null,
    canReorder: Boolean(cook?.slugHandle && order.menuItemId),
    cancellable: await isOrderCancellable(db, order, cook),
    cancelRequestable: await isOrderCancelRequestable(db, order, cook),
    deliveryWindow,
    fulfillmentMode: order.fulfillmentMode ?? "DELIVERY",
    logisticsMode: order.logisticsMode ?? "SELF",
    kitchenDeliveryType: cook?.deliveryType === "PARTNER" ? "PARTNER" : "SELF",
    partnerShipmentId: order.partnerShipmentId ?? null,
    partnerTrackingUrl:
      order.logisticsMode === "PARTNER"
        ? partnerTrackingUrl(order.partnerShipmentId, order.partnerTrackingUrl)
        : null,
    pickup: audience === "public" ? null : pickupRevealForOrder(order),
    roleOnOrder,
    /** Child Pays: senior should wait on confirmed, not be forced into UPI. */
    awaitingFamilyPay:
      pendingPay &&
      Boolean(order.payerMobile) &&
      roleOnOrder === "CUSTOMER" &&
      order.payerMobile !== order.customerMobile,
    canReview:
      audience !== "public" && isOrderReviewable(order.status) && !existingReview,
    hasReview: audience !== "public" && Boolean(existingReview),
    review:
      audience !== "public" && existingReview
        ? {
            id: existingReview.id,
            rating: existingReview.rating,
            comment: existingReview.comment,
            cookReply: existingReview.cookReply,
          }
        : null,
    paymentUrl: pendingPay
      ? await resolveCustomerPaymentUrl(db, {
          orderId: order.id,
          publicId: order.publicId,
          gatewayTxnId: order.gatewayTxnId,
          checkoutId: order.checkoutId,
        })
      : undefined,
  };
  return redactOrderForAudience(
    order as unknown as Record<string, unknown>,
    audience,
    extras,
  );
});


app.post("/orders/:publicId/concern/photo", {
  config: { rateLimit: { max: 20, timeWindow: "15 minutes" } },
}, async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer" });
  }
  const { publicId } = req.params as { publicId: string };
  try {
    const order = await getOrderByPublicId(db, publicId);
    if (!order) throw new Error("Order not found");
    const { assertCustomerOwnsOrder } = await import("../http/orderOwnership.js");
    assertCustomerOwnsOrder(order, user.mobile);
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "photo file required" });
    const url = await saveConcernImage(file);
    return { url };
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/concern", {
  config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
}, async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer to raise a concern" });
  }
  const { publicId } = req.params as { publicId: string };
  try {
    const body = z
      .object({
        category: z.enum([
          "QUALITY",
          "FOODBORNE",
          "WRONG_ITEM",
          "MISSING_DELIVERY",
          "DELAY",
          "PAYMENT",
          "OTHER",
        ]),
        summary: z.string().min(10).max(2000),
        photoUrl: z.string().max(200).nullable().optional(),
      })
      .parse(req.body ?? {});
    return await createOrderConcern(db, {
      customerMobile: user.mobile,
      orderPublicId: publicId,
      category: body.category,
      summary: body.summary,
      photoUrl: assertSafeConcernPhotoUrl(body.photoUrl),
    });
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/orders/:publicId/review", async (req, reply) => {
  const user = currentUser(req);
  if (!user || user.role !== "CUSTOMER") {
    return reply.code(401).send({ error: "Sign in as customer to leave a review" });
  }
  const { publicId } = req.params as { publicId: string };
  const body = z
    .object({
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(500).optional().nullable(),
    })
    .parse(req.body ?? {});
  try {
    const review = await createReviewForOrder(db, {
      publicId,
      customerMobile: user.mobile,
      rating: body.rating,
      comment: body.comment,
    });
    return reply.code(201).send(review);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.get("/kitchens/:slug/reviews", async (req, reply) => {
  const { slug } = req.params as { slug: string };
  const data = await listPublicKitchenReviews(db, slug);
  if (!data) return reply.code(404).send({ error: "Kitchen not found" });
  return data;
});

app.post("/orders/:publicId/cancel", async (req, reply) => {
  const { publicId } = req.params as { publicId: string };
  try {
    const user = requireRole(currentUser(req), ["CUSTOMER", "COOK", "ADMIN"]);
    const order = await getOrderByPublicId(db, publicId);
    if (!order) throw new Error("Order not found");
    if (user.role === "CUSTOMER") {
      const { assertCustomerOwnsOrder } = await import("../http/orderOwnership.js");
      assertCustomerOwnsOrder(order, user.mobile);
    } else if (user.role === "COOK") {
      const cook = await findCookById(db, order.cookId);
      if (!cook || cook.slugHandle !== user.cookSlug) throw new Error("Not your kitchen");
    }
    return await cancelOrder(db, publicId);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

/** Admin: refund a day-line by public id (FULL = food after discount + delivery + platform on that line). */
app.post("/orders/:publicId/refund", async (req, reply) => {
  const { publicId } = req.params as { publicId: string };
  const body = z
    .object({
      mode: z.enum(["FULL", "FOOD_ONLY"]).default("FULL"),
      reason: z.string().min(3).max(300),
      ticketId: z.number().int().positive().optional(),
    })
    .parse(req.body ?? {});
  try {
    requireRole(currentUser(req), ["ADMIN"]);
    const { refundOrderByPublicId } = await import("../services/admin.js");
    return await refundOrderByPublicId(db, publicId, body);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

app.post("/checkouts/:checkoutId/cancel", async (req, reply) => {
  const { checkoutId } = req.params as { checkoutId: string };
  try {
    const user = requireRole(currentUser(req), ["CUSTOMER", "COOK", "ADMIN"]);
    const checkout = await getCheckoutById(db, checkoutId);
    if (!checkout?.orders?.length) throw new Error("Checkout not found");
    const seed = checkout.orders[0];
    if (user.role === "CUSTOMER") {
      const { assertCustomerOwnsCheckout } = await import("../http/orderOwnership.js");
      assertCustomerOwnsCheckout(seed, user.mobile);
    } else if (user.role === "COOK") {
      if (checkout.cookSlug !== user.cookSlug) throw new Error("Not your kitchen");
    }
    return await cancelCheckout(db, checkoutId);
  } catch (e) {
    return sendCaughtError(reply, e);
  }
});

/** Browser / dashboard ping — Razorpay delivers events via POST only. */

app.post(
  "/cooks/apply",
  { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
  async (req, reply) => {
    try {
      const { isSoloKitchenMode } = await import("../soloKitchen.js");
      if (isSoloKitchenMode()) {
        return reply.code(403).send({
          error: "Cook enrollment is paused while LocalMeals runs a single-kitchen launch.",
        });
      }
      const body = z
        .object({
          mobile: z.string().min(10).max(20),
          kitchenName: z.string().min(3).max(100),
          pinCode: z.string().min(6).max(6),
          fssaiNumber: z.string().max(32).nullable().optional(),
          payoutUpiId: z.string().max(80).nullable().optional(),
          payoutAccountNote: z.string().max(500).nullable().optional(),
          pickupLandmark: z.string().max(300).nullable().optional(),
          acceptedKitchenStandards: z.literal(true),
        })
        .parse(req.body ?? {});
      return await applyAsCook(db, body);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  },
);
}
