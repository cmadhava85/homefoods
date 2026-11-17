import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCALE_STORAGE_KEY, localeHeaders, readStoredLocale } from "./locale";

describe("readStoredLocale", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults when window is missing", () => {
    vi.stubGlobal("window", undefined);
    expect(readStoredLocale()).toBe("en");
  });

  it("reads valid stored locale", () => {
    const store = new Map<string, string>([[LOCALE_STORAGE_KEY, "ta"]]);
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: () => undefined,
    });
    expect(readStoredLocale()).toBe("ta");
  });

  it("falls back on invalid or throwing storage", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: () => "xx",
      setItem: () => undefined,
    });
    expect(readStoredLocale()).toBe("en");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
    });
    expect(readStoredLocale()).toBe("en");
  });
});

describe("localeHeaders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sets X-Locale and Accept-Language", () => {
    vi.stubGlobal("window", undefined);
    expect(localeHeaders()).toEqual({
      "X-Locale": "en",
      "Accept-Language": "en",
    });
  });
});
