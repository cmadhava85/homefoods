/**
 * OpenAPI contract gates:
 *  1. the generated spec passes the 42Crunch-style audit rules (audit.ts);
 *  2. every Fastify route is documented and every documented operation exists (no drift);
 *  3. the committed apps/api/openapi.json is up to date (`npm run openapi -w @localmeals/api`).
 */
import "dotenv/config";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDb, closeDb } from "@localmeals/db";
import { buildApp } from "../app.js";
import { auditOpenApi } from "./audit.js";
import { renderSpec, SPEC_PATH } from "./generate.js";
import { allOperations } from "./operations.js";

/** Framework-provided routes that are not part of the API contract. */
const IGNORED = [/^HEAD /, /^OPTIONS /, /^GET \/uploads\/\*$/];

describe("OpenAPI contract", () => {
  it("passes the 42Crunch-style audit rules", () => {
    const violations = auditOpenApi(JSON.parse(renderSpec()));
    assert.deepEqual(violations, [], `\n${violations.join("\n")}`);
  });

  it("documents every route and only real routes (no drift)", async () => {
    const routes = new Set<string>();
    const db = createDb();
    // Production serves uploads from GCS via GET /uploads/:name (registration makes no GCS call).
    const prevBucket = process.env.GCS_UPLOADS_BUCKET;
    process.env.GCS_UPLOADS_BUCKET = "drift-test-bucket";
    const app = buildApp(db, {
      onRoute: ({ method, url }) => {
        for (const m of Array.isArray(method) ? method : [method]) routes.add(`${m} ${url}`);
      },
    });
    await app.ready();
    await app.close();
    await closeDb(db);
    if (prevBucket === undefined) delete process.env.GCS_UPLOADS_BUCKET;
    else process.env.GCS_UPLOADS_BUCKET = prevBucket;

    const inCode = [...routes].filter((r) => !IGNORED.some((re) => re.test(r))).sort();
    const inSpec = allOperations.map((o) => `${o.method.toUpperCase()} ${o.path}`).sort();
    const undocumented = inCode.filter((r) => !inSpec.includes(r));
    const phantom = inSpec.filter((r) => !inCode.includes(r));
    assert.deepEqual({ undocumented, phantom }, { undocumented: [], phantom: [] });
  });

  it("flags credentials in query strings unless the operation states a justification", () => {
    const spec = (justification?: string) => ({
      paths: {
        "/x": {
          get: {
            ...(justification ? { "x-credential-query-justification": justification } : {}),
            parameters: [{ in: "query", name: "api_key", schema: { type: "string", maxLength: 10 } }],
            responses: { "200": { content: { "text/plain": { schema: { type: "string", maxLength: 5 } } } } },
          },
        },
      },
    });
    assert.ok(auditOpenApi(spec()).some((v) => /credential-like query parameter api_key/.test(v)));
    assert.equal(auditOpenApi(spec("vendor handshake")).some((v) => /credential-like/.test(v)), false);
  });

  it("committed openapi.json matches the contracts", () => {
    const committed = readFileSync(SPEC_PATH, "utf8");
    assert.equal(committed, renderSpec(), "run: npm run openapi -w @localmeals/api");
  });
});
