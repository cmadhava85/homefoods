import { describe, expect, it } from "vitest";
import { uploadSrc } from "./uploadUrl";
import { API_BASE } from "./api";

describe("uploadSrc", () => {
  const base = "https://storage.googleapis.com/p-menu";
  it("serves menu photos from the public bucket when configured", () => {
    expect(uploadSrc("/uploads/menu-abc.jpg", base)).toBe(`${base}/menu-abc.jpg`);
    expect(uploadSrc("/uploads/menu-abc.jpg", `${base}/`)).toBe(`${base}/menu-abc.jpg`);
  });
  it("keeps concern photos and unconfigured setups behind the API", () => {
    expect(uploadSrc("/uploads/concern-x.jpg", base)).toBe(`${API_BASE}/uploads/concern-x.jpg`);
    expect(uploadSrc("/uploads/menu-abc.jpg", "")).toBe(`${API_BASE}/uploads/menu-abc.jpg`);
  });
  it("passes absolute URLs through and handles empty values", () => {
    expect(uploadSrc("https://x/y.jpg", base)).toBe("https://x/y.jpg");
    expect(uploadSrc(null, base)).toBeNull();
  });
});
