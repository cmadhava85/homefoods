import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import { Count, IsoDate, Paise } from "../openapi/shared.js";

/** Migration / outbox counters — bounded for OpenAPI integer rules. */
const SchemaCount = z.number().int().min(0).max(100_000);
const AgeSec = z.number().int().min(0).max(100_000_000);

export const metaOperations = defineOperations([
  {
    method: "get",
    path: "/health",
    operationId: "health",
    summary: "Liveness probe",
    tags: ["Meta"],
    access: "public",
    response: z.object({ ok: z.literal(true) }),
  },
  {
    method: "get",
    path: "/ready",
    operationId: "ready",
    summary: "Readiness probe (DB + schema + outbox snapshot)",
    tags: ["Meta"],
    access: "public",
    response: z.object({
      ok: z.boolean(),
      db: z.boolean(),
      schema: z.object({
        ok: z.boolean(),
        expected: SchemaCount,
        applied: SchemaCount,
      }),
      outbox: z.object({
        pending: Count,
        oldestPendingAgeSec: AgeSec.nullable(),
      }),
    }),
  },
  {
    method: "get",
    path: "/meta/today",
    operationId: "getServiceDate",
    summary: "Today's service date in Asia/Kolkata",
    tags: ["Meta"],
    access: "public",
    response: z.object({ serviceDate: IsoDate }),
  },
  {
    method: "get",
    path: "/meta/features",
    operationId: "getFeatureFlags",
    summary: "Public feature flags (kill switches, optional features)",
    tags: ["Meta"],
    access: "public",
    response: z.object({
      flags: z.record(z.string().max(64).regex(/^[a-z0-9_]+$/), z.boolean()).describe("Flag key → enabled"),
      pricing: z
        .object({ platformFeePaise: Paise.describe("Customer platform fee per checkout") })
        .describe("Live customer-facing pricing"),
    }),
  },
]);
