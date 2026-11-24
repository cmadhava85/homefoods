import { z } from "zod";
import { defineOperations } from "../openapi/registry.js";
import { IsoDate } from "../openapi/shared.js";

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
    }),
  },
]);
