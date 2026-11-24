import { describe, expect, it } from "vitest";
import { requestIdFromResponse, withRequestRef } from "./requestRef";

describe("requestRef", () => {
  it("prefers X-Request-Id header over body", () => {
    const res = new Response(null, { headers: { "X-Request-Id": "hdr-1" } });
    expect(requestIdFromResponse(res, { requestId: "body-1" })).toBe("hdr-1");
  });

  it("falls back to body.requestId", () => {
    const res = new Response(null);
    expect(requestIdFromResponse(res, { requestId: "body-2" })).toBe("body-2");
  });

  it("appends Reference when missing from the message", () => {
    expect(withRequestRef("Nope", "abc")).toBe("Nope (Reference: abc)");
    expect(withRequestRef("Nope abc", "abc")).toBe("Nope abc");
  });
});
