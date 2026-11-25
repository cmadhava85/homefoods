import { describe, expect, it } from "vitest";
import { friendlyServiceDate } from "./serviceDate";

const labels = { today: "Today", tomorrow: "Tomorrow" };
// 2026-11-25 22:00 IST == 16:30 UTC
const now = new Date("2026-11-25T16:30:00Z");

describe("friendlyServiceDate", () => {
  it("labels today and tomorrow in IST", () => {
    expect(friendlyServiceDate("2026-11-25", "en", labels, now)).toBe("Today");
    expect(friendlyServiceDate("2026-11-26", "en", labels, now)).toBe("Tomorrow");
  });

  it("uses IST, not UTC, to decide 'today' late in the evening", () => {
    // 2026-11-25 19:00 UTC is already 2026-11-26 00:30 IST.
    const lateUtc = new Date("2026-11-25T19:00:00Z");
    expect(friendlyServiceDate("2026-11-26", "en", labels, lateUtc)).toBe("Today");
  });

  it("formats later dates as short weekday + day + month", () => {
    expect(friendlyServiceDate("2026-11-28", "en", labels, now)).toBe("Sat, 28 Nov");
  });

  it("adds the year for dates outside the current year", () => {
    expect(friendlyServiceDate("2018-12-08", "en", labels, now)).toBe("Sat, 8 Dec, 2018");
  });

  it("passes through malformed input", () => {
    expect(friendlyServiceDate("soon", "en", labels, now)).toBe("soon");
  });
});
