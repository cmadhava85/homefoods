import type { Locale } from "@localmeals/i18n";

const SERVICE_TZ = "Asia/Kolkata";

export function todayServiceISO(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: SERVICE_TZ }).format(now);
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Human label for a YYYY-MM-DD service date: "Today", "Tomorrow", or "Thu, 26 Nov". */
export function friendlyServiceDate(
  iso: string,
  locale: Locale,
  labels: { today: string; tomorrow: string },
  now: Date = new Date(),
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const today = todayServiceISO(now);
  if (iso === today) return labels.today;
  if (iso === addDaysISO(today, 1)) return labels.tomorrow;
  return new Intl.DateTimeFormat(locale === "ta" ? "ta-IN" : "en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(iso.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" as const } : {}),
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}
