import type { FastifyInstance } from "fastify";
import type { Db } from "@localmeals/db";
import type { AuthHelpers } from "../http/authContext.js";
import { sendCaughtError } from "../httpErrors.js";
import { clearSessionCookieHeader } from "../services/auth.js";
import { deleteCustomerAccount } from "../services/accountDeletion.js";
import { DeleteAccountBody } from "./accountRoutes.contract.js";

export async function accountRoutes(app: FastifyInstance, opts: { db: Db; auth: AuthHelpers }) {
  const { db, auth } = opts;

  app.get("/me/credits", async (req, reply) => {
    try {
      const mobile = auth.bindCustomerMobile(req);
      const { creditSummary } = await import("../services/credits.js");
      return await creditSummary(db, mobile);
    } catch (err) {
      return sendCaughtError(reply, err);
    }
  });

  app.post(
    "/me/account/delete",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      try {
        const mobile = auth.bindCustomerMobile(req);
        DeleteAccountBody.parse(req.body);
        const result = await deleteCustomerAccount(db, mobile);
        reply.header("Set-Cookie", clearSessionCookieHeader());
        return result;
      } catch (err) {
        return sendCaughtError(reply, err);
      }
    },
  );
}
