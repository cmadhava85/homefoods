import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rateLimitKey, trustProxySetting } from "./rateLimitKey.js";

describe("rateLimitKey", () => {
  it("keys signed-in callers by session (bearer or cookie), not the shared proxy IP", () => {
    const viaBearer = rateLimitKey({ ip: "10.0.0.1", headers: { authorization: "Bearer tok-a" } });
    const viaCookie = rateLimitKey({ ip: "10.0.0.1", headers: { cookie: "x=1; lm_session=tok-a" } });
    const otherUser = rateLimitKey({ ip: "10.0.0.1", headers: { authorization: "Bearer tok-b" } });
    assert.equal(viaBearer, viaCookie);
    assert.notEqual(viaBearer, otherUser);
    assert.match(viaBearer, /^s:[0-9a-f]{32}$/);
    assert.ok(!viaBearer.includes("tok-a"), "raw token must not be stored as the bucket key");
  });

  it("falls back to IP for anonymous callers", () => {
    assert.equal(rateLimitKey({ ip: "203.0.113.9", headers: {} }), "ip:203.0.113.9");
  });
});

describe("trustProxySetting", () => {
  it("is off by default and parses true / hop count / CIDR list", () => {
    assert.equal(trustProxySetting(undefined), false);
    assert.equal(trustProxySetting("false"), false);
    assert.equal(trustProxySetting("true"), true);
    const oneHop = trustProxySetting("1") as (addr: string, hop: number) => boolean;
    assert.equal(oneHop("10.0.0.1", 0), true);
    assert.equal(oneHop("203.0.113.5", 1), false, "only the nearest proxy is trusted");
    assert.deepEqual(trustProxySetting("35.191.0.0/16, 130.211.0.0/22"), ["35.191.0.0/16", "130.211.0.0/22"]);
  });
});
