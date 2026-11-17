import { describe, expect, it } from "vitest";
import { loginPath } from "./auth";

describe("loginPath", () => {
  it("keeps plain login links backward compatible", () => {
    expect(loginPath("CUSTOMER")).toBe("/login?role=customer");
  });

  it("enables account switching with a switch flag", () => {
    expect(loginPath("CUSTOMER", "/orders", true)).toBe("/login?role=customer&next=%2Forders&switch=1");
  });
});
