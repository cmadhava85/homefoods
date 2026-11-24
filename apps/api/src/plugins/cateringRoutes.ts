import type { FastifyInstance } from "fastify";
import type { Db } from "@localmeals/db";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";
import { assertInternalOrRoles } from "../services/internalAuth.js";
import {
  AdminCancelBody,
  AdminListQuery,
  BookingParams,
  CancelBody,
  ComboBody,
  CookPaidBody,
  CreateBookingBody,
  ManualPaymentBody,
  SettingsBody,
  SlugBookingParams,
  SlugComboParams,
  SlugParams,
} from "./cateringRoutes.contract.js";
import {
  adminMarkCateringCookPaid,
  adminRecordCateringPayment,
  cancelCateringBooking,
  completeCateringBooking,
  confirmCateringPayment,
  createCateringBooking,
  getCookCateringDesk,
  getCustomerCateringBooking,
  getPublicKitchenCatering,
  listCateringBookingsAdmin,
  listCustomerCateringBookings,
  payCateringBooking,
  sendCateringBalanceReminders,
  updateCookCateringSettings,
  upsertCateringCombo,
} from "../services/catering.js";

/** MVP-3 party / bulk catering — every mutator that creates new commitments checks catering_enabled. */
export async function cateringRoutes(app: FastifyInstance, opts: { db: Db; auth: AuthHelpers }) {
  const { db, auth } = opts;
  const { assertAuthed, assertKitchenStaff, bindCustomerMobile } = auth;
  const limited = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  /* ───────── Customer ───────── */

  app.get("/kitchens/:slug/catering", async (req, reply) => {
    try {
      const { slug } = SlugParams.parse(req.params);
      return await getPublicKitchenCatering(db, slug);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/catering/bookings", limited, async (req, reply) => {
    try {
      const customerMobile = bindCustomerMobile(req);
      const body = CreateBookingBody.parse(req.body ?? {});
      return await createCateringBooking(db, { ...body, customerMobile });
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.get("/me/catering/bookings", async (req, reply) => {
    try {
      return await listCustomerCateringBookings(db, bindCustomerMobile(req));
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.get("/catering/bookings/:publicId", async (req, reply) => {
    try {
      const customerMobile = bindCustomerMobile(req);
      const { publicId } = BookingParams.parse(req.params);
      return await getCustomerCateringBooking(db, publicId, customerMobile);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/catering/bookings/:publicId/pay", limited, async (req, reply) => {
    try {
      const customerMobile = bindCustomerMobile(req);
      const { publicId } = BookingParams.parse(req.params);
      return await payCateringBooking(db, publicId, customerMobile);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/catering/bookings/:publicId/confirm", limited, async (req, reply) => {
    try {
      const customerMobile = bindCustomerMobile(req);
      const { publicId } = BookingParams.parse(req.params);
      return await confirmCateringPayment(db, publicId, customerMobile);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/catering/bookings/:publicId/cancel", async (req, reply) => {
    try {
      const customerMobile = bindCustomerMobile(req);
      const { publicId } = BookingParams.parse(req.params);
      const body = CancelBody.parse(req.body ?? {});
      return await cancelCateringBooking(db, {
        publicId,
        by: "CUSTOMER",
        customerMobile,
        reason: body.reason,
      });
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  /* ───────── Cook desk ───────── */

  app.get("/cooks/:slug/catering", async (req, reply) => {
    try {
      const { slug } = SlugParams.parse(req.params);
      assertKitchenStaff(req, slug);
      return await getCookCateringDesk(db, slug);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.patch("/cooks/:slug/catering/settings", async (req, reply) => {
    try {
      const { slug } = SlugParams.parse(req.params);
      assertKitchenStaff(req, slug);
      return await updateCookCateringSettings(db, slug, SettingsBody.parse(req.body ?? {}));
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/cooks/:slug/catering/combos", async (req, reply) => {
    try {
      const { slug } = SlugParams.parse(req.params);
      assertKitchenStaff(req, slug);
      return await upsertCateringCombo(db, slug, ComboBody.parse(req.body ?? {}));
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.put("/cooks/:slug/catering/combos/:id", async (req, reply) => {
    try {
      const { slug, id } = SlugComboParams.parse(req.params);
      assertKitchenStaff(req, slug);
      return await upsertCateringCombo(db, slug, { ...ComboBody.parse(req.body ?? {}), id: Number(id) });
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/cooks/:slug/catering/bookings/:publicId/complete", async (req, reply) => {
    try {
      const { slug, publicId } = SlugBookingParams.parse(req.params);
      assertKitchenStaff(req, slug);
      return await completeCateringBooking(db, slug, publicId);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/cooks/:slug/catering/bookings/:publicId/cancel", async (req, reply) => {
    try {
      const { slug, publicId } = SlugBookingParams.parse(req.params);
      assertKitchenStaff(req, slug);
      const body = CancelBody.parse(req.body ?? {});
      return await cancelCateringBooking(db, { publicId, by: "COOK", cookSlug: slug, reason: body.reason });
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  /* ───────── Admin / jobs ───────── */

  app.get("/admin/catering/bookings", async (req, reply) => {
    try {
      assertAuthed(req, ["ADMIN"]);
      const q = AdminListQuery.parse(req.query ?? {});
      return await listCateringBookingsAdmin(db, q);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/admin/catering/bookings/:publicId/cancel", async (req, reply) => {
    try {
      const user = assertAuthed(req, ["ADMIN"]);
      const { publicId } = BookingParams.parse(req.params);
      const body = AdminCancelBody.parse(req.body ?? {});
      return await cancelCateringBooking(db, {
        publicId,
        by: "ADMIN",
        actor: user.mobile,
        reason: body.reason,
        refundPaise: body.refundPaise,
      });
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/admin/catering/bookings/:publicId/manual-payment", async (req, reply) => {
    try {
      const user = assertAuthed(req, ["ADMIN"]);
      const { publicId } = BookingParams.parse(req.params);
      const body = ManualPaymentBody.parse(req.body ?? {});
      return await adminRecordCateringPayment(db, publicId, { ...body, actor: user.mobile });
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/admin/catering/bookings/:publicId/cook-paid", async (req, reply) => {
    try {
      const user = assertAuthed(req, ["ADMIN"]);
      const { publicId } = BookingParams.parse(req.params);
      const body = CookPaidBody.parse(req.body ?? {});
      return await adminMarkCateringCookPaid(db, publicId, { ...body, actor: user.mobile });
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });

  app.post("/internal/catering/balance-reminders", async (req, reply) => {
    try {
      await assertInternalOrRoles(db, req.headers, ["ADMIN"]);
      return await sendCateringBalanceReminders(db);
    } catch (e) {
      return sendCaughtError(reply, e);
    }
  });
}
