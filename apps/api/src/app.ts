import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { createDb, type Db } from "@localmeals/db";
import { fastifyLoggerOptions } from "@localmeals/observability";
import { createPgRateLimitStore } from "./services/pgRateLimitStore.js";
import { registerApiErrorHandler } from "./httpErrors.js";
import { createAuthHelpers, registerSessionHook } from "./http/authContext.js";
import { genRequestId, registerObservability } from "./observabilityPlugin.js";
import { uploadsDir, usesGcsUploads } from "./uploads.js";
import { authRoutes } from "./plugins/authRoutes.js";
import { customerRoutes } from "./plugins/customerRoutes.js";
import { cookRoutes } from "./plugins/cookRoutes.js";
import { adminRoutes } from "./plugins/adminRoutes.js";
import { paymentRoutes } from "./plugins/paymentRoutes.js";
import { internalRoutes } from "./plugins/internalRoutes.js";
import { metaRoutes } from "./plugins/metaRoutes.js";
import { whatsappWebhook } from "./plugins/whatsappWebhook.js";
import { logisticsWebhook } from "./plugins/logisticsWebhook.js";
import { uploadsRoutes } from "./plugins/uploadsRoutes.js";

export type BuildAppOptions = {
  /** Existing Pino/Fastify logger instance (e.g. capture stream in e2e). */
  loggerInstance?: FastifyBaseLogger;
};

export function buildApp(db: Db = createDb(), opts: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    ...(opts.loggerInstance
      ? { loggerInstance: opts.loggerInstance }
      : { logger: fastifyLoggerOptions("localmeals-api") }),
    // Structured access logs come from registerObservability (request.completed).
    disableRequestLogging: true,
    requestIdHeader: "x-request-id",
    requestIdLogLabel: "requestId",
    genReqId: genRequestId,
  });
  registerObservability(app);
  registerApiErrorHandler(app);

  // Preserve raw JSON for Razorpay / Meta HMAC verification
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const raw = typeof body === "string" ? body : body.toString("utf8");
    (req as { rawBody?: string }).rawBody = raw;
    try {
      done(null, raw ? JSON.parse(raw) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  const webOrigin = (process.env.WEB_ORIGIN ?? "http://localhost:3000").replace(/\/$/, "");
  const corsOrigins = new Set(
    [
      webOrigin,
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      ...(process.env.CORS_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ].filter(Boolean),
  );
  app.register(cors, {
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (corsOrigins.has(origin)) return cb(null, true);
      cb(new Error("CORS origin not allowed"), false);
    },
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Internal-Token",
      "X-Locale",
      "Accept-Language",
      "X-Request-Id",
      "X-Trace-Id",
    ],
    exposedHeaders: ["X-Request-Id", "X-Trace-Id"],
  });

  const rateLimitFailOpen = process.env.NODE_ENV !== "production";
  const mockAuth =
    (process.env.MOCK_AUTH ?? "true").trim().toLowerCase() !== "false";
  // Local mock: avoid 429 storms while polling order/confirm pages.
  const defaultMax = mockAuth && process.env.NODE_ENV !== "production" ? 5000 : 300;
  app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? defaultMax),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
    store: createPgRateLimitStore(db),
    // Prod: fail closed if the store errors so limits are not silently skipped.
    skipOnError: rateLimitFailOpen,
    allowList: (req) => {
      const url = req.url.split("?")[0] ?? "";
      return url === "/health" || (req.method === "GET" && url.startsWith("/webhooks/whatsapp"));
    },
  });

  registerSessionHook(app, db);
  const auth = createAuthHelpers(db);

  app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });
  if (usesGcsUploads()) {
    void app.register(uploadsRoutes);
  } else {
    app.register(fastifyStatic, {
      root: uploadsDir(),
      prefix: "/uploads/",
      decorateReply: false,
      // @fastify/static ≥8 passes FastifyReply (use .header), not Node ServerResponse.
      setHeaders(reply) {
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header("Cache-Control", "public, max-age=86400");
        reply.header("Content-Disposition", "inline");
      },
    });
  }

  const deps = { db, auth };
  void app.register(metaRoutes, deps);
  void app.register(authRoutes, deps);
  void app.register(customerRoutes, deps);
  void app.register(paymentRoutes, deps);
  void app.register(cookRoutes, deps);
  void app.register(internalRoutes, deps);
  void app.register(adminRoutes, deps);
  void app.register(whatsappWebhook, { db });
  void app.register(logisticsWebhook, { db });

  return app;
}
