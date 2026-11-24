/**
 * Builds the OpenAPI 3.0 document from the per-plugin contracts (plugins/*.contract.ts).
 * The same zod schemas the handlers use to parse requests are converted here, so the spec
 * cannot drift from what the API accepts. Regenerate with `npm run openapi -w @localmeals/api`.
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { Access, ApiOperation } from "./registry.js";
import { ErrorResponse } from "./shared.js";

type Json = Record<string, unknown>;

function schemaOf(schema: ZodTypeAny): Json {
  const out = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as Json;
  delete out.$schema;
  delete out.definitions;
  return out;
}

const SECURITY_SCHEMES = {
  sessionCookie: {
    type: "apiKey",
    in: "cookie",
    name: "lm_session",
    description: "HttpOnly session cookie set by POST /auth/otp/verify (primary for browsers).",
  },
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "HMAC-signed session token",
    description: "Same session token as a Bearer header (non-browser clients, local tooling).",
  },
  internalToken: {
    type: "apiKey",
    in: "header",
    name: "X-Internal-Token",
    description: "Shared secret for Cloud Scheduler / worker jobs (INTERNAL_JOB_TOKEN).",
  },
  razorpaySignature: {
    type: "apiKey",
    in: "header",
    name: "X-Razorpay-Signature",
    description: "HMAC-SHA256 of the raw body with RAZORPAY_WEBHOOK_SECRET.",
  },
  metaSignature: {
    type: "apiKey",
    in: "header",
    name: "X-Hub-Signature-256",
    description: "Meta WhatsApp webhook HMAC (sha256=…) of the raw body with WHATSAPP_APP_SECRET.",
  },
  logisticsSignature: {
    type: "apiKey",
    in: "header",
    name: "X-Logistics-Signature",
    description: "HMAC-SHA256 of the raw body (or X-Logistics-Secret shared secret).",
  },
} as const;

const SESSION = [{ sessionCookie: [] }, { bearerAuth: [] }];

function securityFor(access: Access): Json[] {
  switch (access) {
    case "public":
      return [];
    case "optionalSession":
      return [{}, ...SESSION];
    case "internal":
      return [{ internalToken: [] }, ...SESSION];
    case "webhook:razorpay":
      return [{ razorpaySignature: [] }];
    case "webhook:meta":
      return [{ metaSignature: [] }];
    case "webhook:logistics":
      return [{ logisticsSignature: [] }];
    default:
      return SESSION;
  }
}

const error = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
});

function toOpenApiPath(path: string) {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function parameters(op: ApiOperation): Json[] {
  const out: Json[] = [];
  for (const [where, obj] of [
    ["path", op.params],
    ["query", op.query],
  ] as const) {
    if (!obj) continue;
    for (const [name, field] of Object.entries(obj.shape as Record<string, ZodTypeAny>)) {
      const schema = schemaOf(field);
      const description = (schema.description as string | undefined) ?? field.description;
      delete schema.description;
      out.push({
        name,
        in: where,
        required: where === "path" ? true : !field.isOptional(),
        ...(description ? { description } : {}),
        schema,
      });
    }
  }
  return out;
}

function operation(op: ApiOperation): Json {
  const secured = op.access !== "public";
  const hasInput = Boolean(op.params || op.query || op.body);
  const success = String(op.successStatus ?? 200);
  const responses: Json = {
    [success]: {
      description: op.successStatus === 201 ? "Created" : "OK",
      content: {
        [op.responseContentType ?? "application/json"]: { schema: schemaOf(op.response) },
      },
    },
  };
  if (hasInput) responses["400"] = error("Invalid request (validation or business rule)");
  if (secured) {
    responses["401"] = error("Not signed in / invalid credentials or signature");
    responses["403"] = error("Signed in but not allowed for this resource");
  }
  if (op.params) responses["404"] = error("Not found");
  for (const [status, description] of Object.entries(op.errors ?? {})) {
    responses[status] = error(description as string);
  }
  responses["429"] = error("Rate limited");
  responses["500"] = error("Unexpected server error");

  return {
    operationId: op.operationId,
    summary: op.summary,
    tags: op.tags,
    "x-access": op.access,
    ...(op.credentialQueryJustification
      ? { "x-credential-query-justification": op.credentialQueryJustification }
      : {}),
    security: securityFor(op.access),
    ...(parameters(op).length ? { parameters: parameters(op) } : {}),
    ...(op.body
      ? {
          requestBody: {
            required: true,
            content: { [op.bodyContentType ?? "application/json"]: { schema: schemaOf(op.body) } },
          },
        }
      : {}),
    responses: Object.fromEntries(
      Object.entries(responses).sort(([a], [b]) => Number(a) - Number(b)),
    ),
  };
}

export function buildOpenApi(ops: ApiOperation[], version: string) {
  const paths: Record<string, Record<string, Json>> = {};
  const sorted = [...ops].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  for (const op of sorted) {
    const p = toOpenApiPath(op.path);
    paths[p] ??= {};
    paths[p][op.method] = operation(op);
  }
  const tags = [...new Set(ops.flatMap((o) => o.tags))].sort().map((name) => ({ name }));
  return {
    openapi: "3.0.3",
    info: {
      title: "LocalMeals API",
      version,
      description:
        "Home-cooked meal ordering (web + WhatsApp), cook desk, admin and payment/logistics webhooks. " +
        "Generated from the zod contracts in apps/api/src/plugins/*.contract.ts — do not edit by hand.",
    },
    servers: [
      {
        url: "https://{apiHost}",
        description: "Cloud Run API (HTTPS only)",
        variables: { apiHost: { default: "api.localmeals.in", description: "API host name" } },
      },
    ],
    security: SESSION,
    tags,
    paths,
    components: {
      securitySchemes: SECURITY_SCHEMES,
      schemas: { ErrorResponse: schemaOf(ErrorResponse) },
    },
  };
}
