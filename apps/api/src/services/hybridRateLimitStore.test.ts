import "dotenv/config";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { sql } from "drizzle-orm";
import { closeDb, createDb, type Db } from "@localmeals/db";
import { createHybridRateLimitStore } from "./pgRateLimitStore.js";

describe("hybrid rate-limit store", () => {
  const db = createDb();
  after(() => closeDb(db));

  it("counts the global limit in memory without any DB call", async () => {
    const explode = new Proxy({}, { get: () => { throw new Error("DB touched"); } }) as unknown as Db;
    const Store = createHybridRateLimitStore(explode);
    const store = new Store({});
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      store.incr("1.2.3.4", (err, r) => { assert.equal(err, null); seen.push(r!.current); }, 60_000);
    }
    assert.deepEqual(seen, [1, 2, 3]);
  });

  it("evicts the oldest key when full and resets after the window", async () => {
    const Store = createHybridRateLimitStore(db, 2);
    const store = new Store({});
    const cur = (k: string, w = 60_000) => {
      let c = 0;
      store.incr(k, (_e, r) => { c = r!.current; }, w);
      return c;
    };
    cur("a"); cur("a"); cur("b"); cur("c"); // "a" evicted
    assert.equal(cur("a"), 1);
    assert.equal(cur("z", -1), 1);
    assert.equal(cur("z", -1), 1);
  });

  it("route-level limits stay in Postgres and hold across instances", async () => {
    const tag = `hyb-${Date.now()}`;
    async function instance() {
      const app = Fastify();
      await app.register(rateLimit, { global: true, max: 1000, timeWindow: "1 minute", store: createHybridRateLimitStore(db) });
      app.post(`/${tag}`, { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } }, async () => ({ ok: true }));
      app.get("/free", async () => ({ ok: true }));
      await app.ready();
      return app;
    }
    const [a, b] = [await instance(), await instance()];
    try {
      const codes = [];
      for (const app of [a, b, a]) codes.push((await app.inject({ method: "POST", url: `/${tag}` })).statusCode);
      assert.deepEqual(codes, [200, 200, 429], "limit shared across instances via Postgres");
      const rows = await db.execute(sql`SELECT count(*)::int AS n FROM rate_limit_buckets WHERE bucket_key LIKE ${"%" + tag + "%"}`);
      assert.equal((rows as unknown as Array<{ n: number }>)[0].n, 1);
      const before = await db.execute(sql`SELECT count(*)::int AS n FROM rate_limit_buckets`);
      for (let i = 0; i < 5; i++) await a.inject({ method: "GET", url: "/free" });
      const afterRows = await db.execute(sql`SELECT count(*)::int AS n FROM rate_limit_buckets`);
      assert.equal((afterRows as unknown as Array<{ n: number }>)[0].n, (before as unknown as Array<{ n: number }>)[0].n);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
