import { afterEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "./site";
import { legalDetailsMissing } from "./legal";

afterEach(() => vi.unstubAllEnvs());

describe("siteUrl", () => {
  it("strips trailing slashes and falls back to localhost", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://localmeals.in//");
    expect(siteUrl()).toBe("https://localmeals.in");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(siteUrl()).toBe("http://localhost:3000");
  });
});

describe("legalDetailsMissing", () => {
  const all = {
    NEXT_PUBLIC_LEGAL_ENTITY_NAME: "LocalMeals Foods Pvt Ltd",
    NEXT_PUBLIC_LEGAL_ADDRESS: "Chennai",
    NEXT_PUBLIC_SUPPORT_EMAIL: "help@x.in",
    NEXT_PUBLIC_GRIEVANCE_OFFICER_NAME: "A",
    NEXT_PUBLIC_GRIEVANCE_OFFICER_EMAIL: "g@x.in",
    NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: "2026-12-01",
  };
  it("lists unset business details (drives the draft banner) and clears when all are set", () => {
    for (const [k, v] of Object.entries(all)) vi.stubEnv(k, v);
    expect(legalDetailsMissing()).toEqual([]);
    vi.stubEnv("NEXT_PUBLIC_GRIEVANCE_OFFICER_EMAIL", " ");
    expect(legalDetailsMissing()).toEqual(["NEXT_PUBLIC_GRIEVANCE_OFFICER_EMAIL"]);
  });
});
