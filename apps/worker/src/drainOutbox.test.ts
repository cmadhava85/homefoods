import "dotenv/config";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { inArray, isNull, sql } from "drizzle-orm";
import { closeDb, createDb, outbox } from "@localmeals/db";
import { getWhatsAppProvider, isMockWhatsApp, resetWhatsAppProvider } from "@localmeals/adapters";
import { drainOutboxOnce } from "./drainOutbox.js";

process.env.MOCK_WHATSAPP = "true";
resetWhatsAppProvider();

describe("drainOutboxOnce lease claim", () => {
  const db = createDb();

  before(async () => {
    // Isolate from rows left by other suites in the shared test DB.
    await db.update(outbox).set({ processedAt: new Date() }).where(isNull(outbox.processedAt));
  });

  after(async () => {
    await closeDb(db);
  });

  it("an overlapping drain cannot re-claim rows another drain is still processing", async () => {
    const wa = getWhatsAppProvider();
    assert.ok(isMockWhatsApp(wa));
    const mobile = `+9170${String(Date.now()).slice(-8)}`;
    const inserted = await db
      .insert(outbox)
      .values(
        [1, 2, 3].map((n) => ({
          eventName: "OrderRefunded",
          payload: { customerMobile: mobile, publicId: `LM-LEASE${n}`, source: "admin" },
        })),
      )
      .returning({ id: outbox.id });
    const ids = inserted.map((r) => r.id);
    const sentTo = () => wa.sent.filter((m) => m.to === mobile).length;

    // Drain A claims the rows, then blocks before sending (gate stays closed).
    let openGate!: (v: boolean) => void;
    const gate = new Promise<boolean>((resolve) => (openGate = resolve));
    const drainA = drainOutboxOnce(db, { whatsappOutboundAllowed: () => gate, apiBase: "http://x" });

    for (let i = 0; i < 50; i++) {
      const leased = await db
        .select({ id: outbox.id })
        .from(outbox)
        .where(sql`${inArray(outbox.id, ids)} and ${outbox.lockedUntil} > now()`);
      if (leased.length === ids.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Drain B runs to completion while A still holds the lease — it must send nothing for these rows.
    await drainOutboxOnce(db, { whatsappOutboundAllowed: async () => true, apiBase: "http://x" });
    assert.equal(sentTo(), 0, "second drain re-claimed rows leased by the first");

    openGate(true);
    await drainA;
    assert.equal(sentTo(), 3, "each outbox row is sent exactly once");

    const rows = await db.select().from(outbox).where(inArray(outbox.id, ids));
    assert.ok(rows.every((r) => r.processedAt != null));
  });
});
