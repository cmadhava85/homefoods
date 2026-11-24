import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout, UpstreamHttpError } from "./fetchWithTimeout.js";

describe("fetchWithTimeout", () => {
  it("maps HTML 502 body to UpstreamHttpError without SyntaxError", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      })) as typeof fetch;
    try {
      await assert.rejects(
        () => fetchWithTimeout("https://example.test/x", {}, { timeoutMs: 1000, provider: "razorpay" }),
        (err: unknown) => err instanceof UpstreamHttpError && err.statusCode === 502,
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("timeouts become UpstreamHttpError 504", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (_url, init) => {
      await new Promise<void>((_, reject) => {
        const t = setTimeout(() => {
          const err = new Error("aborted");
          err.name = "TimeoutError";
          reject(err);
        }, 5);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          err.name = "TimeoutError";
          reject(err);
        });
      });
      return new Response("ok");
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => fetchWithTimeout("https://example.test/slow", {}, { timeoutMs: 30, provider: "razorpay" }),
        (err: unknown) => err instanceof UpstreamHttpError && err.statusCode === 504,
      );
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("retries transient failures only when retryOnTransient is set", async () => {
    const prev = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls < 3) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const r = await fetchWithTimeout(
        "https://example.test/r",
        {},
        { timeoutMs: 1000, retries: 2, retryOnTransient: true, provider: "razorpay" },
      );
      assert.equal(calls, 3);
      assert.deepEqual(r.json, { ok: true });
    } finally {
      globalThis.fetch = prev;
    }
  });
});
