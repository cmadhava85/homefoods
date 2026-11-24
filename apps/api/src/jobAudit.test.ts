import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq } from "drizzle-orm";
import { adminActionLog, closeDb, createDb } from "@localmeals/db";
import { buildApp } from "./app.js";
import { loginAdmin } from "./testHelpers.js";

process.env.MOCK_PAYMENTS = "true";
process.env.MOCK_WHATSAPP = "true";
process.env.MOCK_AUTH = "true";

describe("job audit (P2-12)", () => {
  const db = createDb();
  const app = buildApp(db);
  const token = "test-job-audit-token";

  before(async () => {
    process.env.INTERNAL_JOB_TOKEN = token;
    await app.ready();
  });

  after(async () => {
    delete process.env.INTERNAL_JOB_TOKEN;
    delete process.env.INTERNAL_OIDC_STUB;
    await app.close();
    await closeDb(db);
  });

  it("audits RUN_EOD with X-Job-Caller=scheduler", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/settlements/eod",
      headers: {
        "x-internal-token": token,
        "x-job-caller": "scheduler",
      },
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await db.query.adminActionLog.findFirst({
      where: eq(adminActionLog.action, "RUN_EOD"),
      orderBy: [desc(adminActionLog.id)],
    });
    assert.ok(row);
    assert.equal(row.actor, "scheduler");
  });

  it("audits RUN_CUTOFF with X-Job-Caller=worker", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/cutoffs/LUNCH",
      headers: {
        "x-internal-token": token,
        "x-job-caller": "worker",
      },
      payload: { force: true },
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await db.query.adminActionLog.findFirst({
      where: and(eq(adminActionLog.action, "RUN_CUTOFF"), eq(adminActionLog.entityId, "LUNCH")),
      orderBy: [desc(adminActionLog.id)],
    });
    assert.ok(row);
    assert.equal(row.actor, "worker");
  });

  it("audits admin console RUN_EOD", async () => {
    const { headers } = await loginAdmin(app);
    const res = await app.inject({
      method: "POST",
      url: "/admin/settlements/run-eod",
      headers,
      payload: {},
    });
    assert.equal(res.statusCode, 200, res.body);

    const row = await db.query.adminActionLog.findFirst({
      where: eq(adminActionLog.action, "RUN_EOD"),
      orderBy: [desc(adminActionLog.id)],
    });
    assert.ok(row);
    assert.notEqual(row.actor, "scheduler");
    assert.notEqual(row.actor, "worker");
  });

  it("OIDC stub accepts Bearer when INTERNAL_OIDC_STUB=true", async () => {
    process.env.INTERNAL_OIDC_STUB = "true";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/ops/retention",
        headers: {
          authorization: "Bearer stub-oidc-token-xxxxxxxxxxxxxx",
          "x-job-caller": "scheduler",
        },
        payload: { mode: "purge" },
      });
      assert.equal(res.statusCode, 200, res.body);
      const row = await db.query.adminActionLog.findFirst({
        where: eq(adminActionLog.action, "RUN_RETENTION"),
        orderBy: [desc(adminActionLog.id)],
      });
      assert.ok(row);
      assert.equal(row.actor, "scheduler");
    } finally {
      delete process.env.INTERNAL_OIDC_STUB;
    }
  });
});
