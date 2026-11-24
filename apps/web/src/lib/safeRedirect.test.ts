import { describe, expect, it } from "vitest";
import { sameOriginPath } from "./safeRedirect";

const ORIGIN = "https://localmeals.app";

describe("sameOriginPath", () => {
  it("keeps normal in-app paths (with query and hash)", () => {
    expect(sameOriginPath("/orders", ORIGIN)).toBe("/orders");
    expect(sameOriginPath("/cook/amma?tab=today#stops", ORIGIN)).toBe("/cook/amma?tab=today#stops");
  });

  it("rejects open-redirect tricks that pass a naive startsWith('/') check", () => {
    for (const evil of [
      "//evil.example",
      "/\\evil.example",
      "/%5Cevil.example".replace("%5C", "\\"),
      "/\t/evil.example",
      "/\n/evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "",
      null,
      undefined,
    ]) {
      expect(sameOriginPath(evil, ORIGIN)).toBeNull();
    }
  });
});
