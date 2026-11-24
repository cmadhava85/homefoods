import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  adminActionLog,
  closeDb,
  createDb,
  supportTickets,
} from "@localmeals/db";
import {
  redactOldAdminActionPayloads,
  redactResolvedTicketPii,
} from "./services/retention.js";

describe("retention redaction (P2-13)", () => {
  const db = createDb();

  before(async () => {
    process.env.PII_RETENTION_DAYS = "180";
  });

  after(async () => {
    await closeDb(db);
  });

  it("redacts mobile fields in old admin_action_log payloads", async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const [row] = await db
      .insert(adminActionLog)
      .values({
        actor: "test",
        action: "TEST_REDACT",
        entityType: "ops",
        entityId: "retention-test",
        payload: { customerMobile: "+919999000001", note: "keep" },
        createdAt: old,
      })
      .returning();

    const n = await redactOldAdminActionPayloads(db, new Date(Date.now() - 180 * 24 * 60 * 60 * 1000));
    assert.ok(n >= 1);

    const got = await db.query.adminActionLog.findFirst({
      where: eq(adminActionLog.id, row.id),
    });
    assert.ok(got?.payload);
    const payload = got.payload as Record<string, unknown>;
    assert.equal(payload.customerMobile, null);
    assert.equal(payload.note, "keep");
  });

  it("redacts customer mobile on resolved tickets past the window", async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        customerMobile: "+919999000002",
        category: "OTHER",
        status: "RESOLVED",
        source: "TEST",
        summary: "retention redact test",
        resolvedAt: old,
        createdAt: old,
      })
      .returning();

    const n = await redactResolvedTicketPii(db, new Date(Date.now() - 180 * 24 * 60 * 60 * 1000));
    assert.ok(n >= 1);

    const got = await db.query.supportTickets.findFirst({
      where: eq(supportTickets.id, ticket.id),
    });
    assert.equal(got?.customerMobile, null);
    assert.equal(got?.summary, "retention redact test");
  });
});
