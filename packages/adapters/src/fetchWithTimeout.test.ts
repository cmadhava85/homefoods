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

  it("attaches response body on HTTP errors so callers can read provider codes", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: { message: "Recipient phone number not in allowed list", code: 131030 },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          fetchWithTimeout("https://example.test/messages", {}, { timeoutMs: 1000, provider: "whatsapp" }),
        (err: unknown) =>
          err instanceof UpstreamHttpError &&
          err.upstreamStatus === 400 &&
          (err.bodyJson as { error?: { code?: number } })?.error?.code === 131030,
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

  it("invokes log on success and maps 429 to UpstreamHttpError 503", async () => {
    const prev = globalThis.fetch;
    const logs: Array<{ fields: Record<string, unknown>; msg: string }> = [];
    globalThis.fetch = (async () => new Response("", { status: 429 })) as typeof fetch;
    try {
      await assert.rejects(
        () =>
          fetchWithTimeout(
            "https://example.test/rate",
            {},
            {
              timeoutMs: 1000,
              provider: "razorpay",
              path: "/v1/payment_links",
              traceId: "trc_rate",
              log: (fields, msg) => logs.push({ fields, msg }),
            },
          ),
        (err: unknown) =>
          err instanceof UpstreamHttpError && err.statusCode === 503 && err.upstreamStatus === 429,
      );
      // Logged once for the HTTP response, again when UpstreamHttpError is rethrown from catch.
      assert.ok(logs.length >= 1);
      assert.equal(logs[0]?.fields.status, 429);
      assert.equal(logs[0]?.fields.path, "/v1/payment_links");
      assert.equal(logs[0]?.fields.traceId, "trc_rate");
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("retries network errors when retryOnTransient is set, then succeeds", async () => {
    const prev = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    try {
      const r = await fetchWithTimeout(
        "https://example.test/net",
        {},
        { timeoutMs: 1000, retries: 1, retryOnTransient: true, provider: "meta" },
      );
      assert.equal(calls, 2);
      assert.deepEqual(r.json, { ok: true });
    } finally {
      globalThis.fetch = prev;
    }
  });

  it("maps upstream 504 response to UpstreamHttpError 504", async () => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async () => new Response("gateway timeout", { status: 504 })) as typeof fetch;
    try {
      await assert.rejects(
        () => fetchWithTimeout("https://example.test/t", {}, { timeoutMs: 1000, provider: "razorpay" }),
        (err: unknown) => err instanceof UpstreamHttpError && err.statusCode === 504,
      );
    } finally {
      globalThis.fetch = prev;
    }
  });
});
