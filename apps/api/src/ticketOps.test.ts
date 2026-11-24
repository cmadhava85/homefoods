/**
 * P1-9: ticket outbox enqueue, cook ticket creation, SLA breach once-log.
 */
import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  closeDb,
  createDb,
  outbox,
  platformEventLedger,
  supportTickets,
} from "@localmeals/db";
import { buildApp } from "./app.js";
import { createTicketFromHelp, createCookTicket } from "./services/admin.js";
import { loginCook } from "./testHelpers.js";

describe("ticket ops (P1-9)", () => {
  const db = createDb();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookHeaders: Record<string, string>;
  let cookId: string;
  let cookSlug: string;

  before(async () => {
    app = buildApp(db);
    await app.ready();
    const cook = await db.query.cookProfiles.findFirst({
      where: (t, { eq: e }) => e(t.slugHandle, "csk-homemade-delights"),
    });
    assert.ok(cook, "seed cook required");
    cookId = cook.id;
    cookSlug = cook.slugHandle;
    const auth = await loginCook(app, cookSlug);
    cookHeaders = auth.headers;
  });

  after(async () => {
    await app.close();
    await closeDb(db);
  });

  it("createTicketFromHelp enqueues TicketCreated outbox", async () => {
    await db.update(outbox).set({ processedAt: new Date() }).where(isNull(outbox.processedAt));
    const ticket = await createTicketFromHelp(db, {
      customerMobile: "+919900009901",
      summary: "WhatsApp help: cannot see menu",
      source: "WHATSAPP",
      category: "OTHER",
    });
    const [row] = await db
      .select()
      .from(outbox)
      .where(and(eq(outbox.eventName, "TicketCreated"), isNull(outbox.processedAt)))
      .orderBy(desc(outbox.id))
      .limit(1);
    assert.ok(row, "TicketCreated pending");
    const payload = row.payload as Record<string, unknown>;
    assert.equal(payload.ticketId, ticket.id);
    assert.equal(payload.category, "OTHER");
    assert.equal(payload.source, "WHATSAPP");
    assert.ok(typeof payload.slaDueAt === "string");
  });

  it("cook desk POST /cooks/:slug/tickets creates source=COOK ticket + outbox", async () => {
    await db.update(outbox).set({ processedAt: new Date() }).where(isNull(outbox.processedAt));
    const res = await app.inject({
      method: "POST",
      url: `/cooks/${cookSlug}/tickets`,
      headers: cookHeaders,
      payload: {
        summary: "Delivery partner no-show at tower gate",
        category: "COOK_OPS",
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.source, "COOK");
    const ticket = await db.query.supportTickets.findFirst({
      where: (t, { eq: e }) => e(t.id, body.ticketId),
    });
    assert.ok(ticket);
    assert.equal(ticket.source, "COOK");
    assert.equal(ticket.cookId, cookId);
    const [row] = await db
      .select()
      .from(outbox)
      .where(and(eq(outbox.eventName, "TicketCreated"), isNull(outbox.processedAt)))
      .orderBy(desc(outbox.id))
      .limit(1);
    assert.ok(row);
    assert.equal((row.payload as { ticketId: number }).ticketId, body.ticketId);
  });

  it("createCookTicket rejects short summaries", async () => {
    await assert.rejects(
      () =>
        createCookTicket(db, {
          cookId,
          cookMobile: "+919900000002",
          summary: "too short",
        }),
      /at least a short sentence/,
    );
  });
});

describe("ticket SLA breach once", () => {
  const db = createDb();

  after(async () => {
    await closeDb(db);
  });

  it("recordTicketSlaBreachedOnce only inserts once per ticket", async () => {
    const { recordTicketSlaBreachedOnce } = await import(
      "../../worker/src/opsLedger.js"
    );
    const cook = await db.query.cookProfiles.findFirst();
    assert.ok(cook);
    const [ticket] = await db
      .insert(supportTickets)
      .values({
        cookId: cook.id,
        customerMobile: "+919900009902",
        category: "DELAY",
        summary: "SLA test ticket",
        source: "WEB",
        status: "OPEN",
        slaDueAt: new Date(Date.now() - 60_000),
      })
      .returning();

    const first = await recordTicketSlaBreachedOnce(db, {
      ticketId: ticket.id,
      cookId: cook.id,
      customerMobile: ticket.customerMobile,
      slaDueAt: ticket.slaDueAt?.toISOString() ?? null,
    });
    const second = await recordTicketSlaBreachedOnce(db, {
      ticketId: ticket.id,
      cookId: cook.id,
      customerMobile: ticket.customerMobile,
      slaDueAt: ticket.slaDueAt?.toISOString() ?? null,
    });
    assert.equal(first, true);
    assert.equal(second, false);

    const rows = await db
      .select()
      .from(platformEventLedger)
      .where(eq(platformEventLedger.eventName, "TICKET_SLA_BREACHED"));
    const forTicket = rows.filter(
      (r) => (r.rawPayload as { ticketId?: number })?.ticketId === ticket.id,
    );
    assert.equal(forTicket.length, 1);
  });
});
