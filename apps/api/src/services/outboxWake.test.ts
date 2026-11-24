import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createOutboxWaker } from "./outboxWake.js";

function fakeFetch(opts: { failPublish?: boolean; onPublish?: () => void } = {}) {
  const calls: Array<{ url: string; body?: string; auth?: string }> = [];
  const impl = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, body: init?.body as string | undefined, auth: headers.get("authorization") ?? undefined });
    if (url.includes("metadata.google.internal")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    opts.onPublish?.();
    return new Response("{}", { status: opts.failPublish ? 503 : 200 });
  };
  return { calls, impl, publishes: () => calls.filter((c) => c.url.includes("pubsub")) };
}

const TOPIC = "projects/p/topics/localmeals.outbox-wake";

describe("outbox waker", () => {
  it("does nothing without a topic (local dev polls)", async () => {
    const f = fakeFetch();
    const w = createOutboxWaker({ fetchImpl: f.impl, debounceMs: 1 });
    w.markDirty();
    await w.flush();
    assert.equal(f.calls.length, 0);
    assert.equal(w.enabled, false);
  });

  it("does not publish when nothing was enqueued", async () => {
    const f = fakeFetch();
    const w = createOutboxWaker({ topic: TOPIC, fetchImpl: f.impl, debounceMs: 1 });
    await w.flush();
    assert.equal(f.calls.length, 0);
  });

  it("coalesces a burst of responses into one publish and caches the token", async () => {
    const f = fakeFetch();
    const w = createOutboxWaker({ topic: TOPIC, fetchImpl: f.impl, debounceMs: 5 });
    const flushes = [];
    for (let i = 0; i < 5; i++) {
      w.markDirty();
      flushes.push(w.flush());
    }
    await Promise.all(flushes);
    assert.equal(f.publishes().length, 1);
    assert.equal(f.publishes()[0].url, `https://pubsub.googleapis.com/v1/${TOPIC}:publish`);
    assert.equal(f.publishes()[0].auth, "Bearer tok");
    assert.deepEqual(JSON.parse(f.publishes()[0].body!), { messages: [{ data: Buffer.from("wake").toString("base64") }] });

    w.markDirty();
    await w.flush();
    assert.equal(f.publishes().length, 2);
    assert.equal(f.calls.filter((c) => c.url.includes("metadata")).length, 1, "token reused");
  });

  it("re-wakes when rows are enqueued while a publish is in flight", async () => {
    let w!: ReturnType<typeof createOutboxWaker>;
    let first = true;
    const f = fakeFetch({
      onPublish: () => {
        if (first) {
          first = false;
          w.markDirty();
        }
      },
    });
    w = createOutboxWaker({ topic: TOPIC, fetchImpl: f.impl, debounceMs: 1 });
    w.markDirty();
    await w.flush();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(f.publishes().length, 2);
  });

  it("swallows publish errors (scheduler fallback drains)", async () => {
    const f = fakeFetch({ failPublish: true });
    const warns: unknown[] = [];
    const w = createOutboxWaker({ topic: TOPIC, fetchImpl: f.impl, debounceMs: 1, logger: { warn: (o) => void warns.push(o) } });
    w.markDirty();
    await w.flush();
    assert.equal(warns.length, 1);
  });
});
