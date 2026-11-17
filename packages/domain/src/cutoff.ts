export type MealPeriod = "BREAKFAST" | "LUNCH" | "DINNER";

export const MEAL_PERIODS: MealPeriod[] = ["BREAKFAST", "LUNCH", "DINNER"];

export type CutoffConfig = {
  hour: number;
  minute: number;
};

export type DeliveryWindow = {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
};

export type MealSchedule = {
  mealType: MealPeriod;
  enabled: boolean;
  cutoff: CutoffConfig;
  deliveryWindow: DeliveryWindow;
};

/** Default schedules when cook has not customized a meal. */
export function defaultMealSchedule(meal: MealPeriod): MealSchedule {
  if (meal === "BREAKFAST") {
    return {
      mealType: "BREAKFAST",
      enabled: false,
      cutoff: { hour: 6, minute: 30 },
      deliveryWindow: { startHour: 7, startMinute: 30, endHour: 8, endMinute: 30 },
    };
  }
  if (meal === "DINNER") {
    return {
      mealType: "DINNER",
      enabled: false,
      cutoff: { hour: 16, minute: 0 },
      deliveryWindow: { startHour: 19, startMinute: 0, endHour: 20, endMinute: 0 },
    };
  }
  return {
    mealType: "LUNCH",
    enabled: true,
    cutoff: {
      hour: Number(process.env.LUNCH_CUTOFF_HOUR ?? 8),
      minute: Number(process.env.LUNCH_CUTOFF_MINUTE ?? 0),
    },
    deliveryWindow: {
      startHour: Number(process.env.LUNCH_DELIVERY_START_HOUR ?? 12),
      startMinute: Number(process.env.LUNCH_DELIVERY_START_MINUTE ?? 0),
      endHour: Number(process.env.LUNCH_DELIVERY_END_HOUR ?? 13),
      endMinute: Number(process.env.LUNCH_DELIVERY_END_MINUTE ?? 0),
    },
  };
}

/** @deprecated Prefer defaultMealSchedule("LUNCH").cutoff */
export function defaultCutoffConfig(): CutoffConfig {
  return defaultMealSchedule("LUNCH").cutoff;
}

/** @deprecated Prefer defaultMealSchedule("LUNCH").deliveryWindow */
export function defaultDeliveryWindow(): DeliveryWindow {
  return defaultMealSchedule("LUNCH").deliveryWindow;
}

/** Legacy lunch columns on cook_profiles → lunch schedule fallback. */
export function lunchScheduleFromLegacyCook(cook: {
  lunchCutoffHour?: number | null;
  lunchCutoffMinute?: number | null;
  deliveryWindowStartHour?: number | null;
  deliveryWindowStartMinute?: number | null;
  deliveryWindowEndHour?: number | null;
  deliveryWindowEndMinute?: number | null;
}): MealSchedule {
  const base = defaultMealSchedule("LUNCH");
  return {
    mealType: "LUNCH",
    enabled: true,
    cutoff: {
      hour: cook.lunchCutoffHour ?? base.cutoff.hour,
      minute: cook.lunchCutoffMinute ?? base.cutoff.minute,
    },
    deliveryWindow: {
      startHour: cook.deliveryWindowStartHour ?? base.deliveryWindow.startHour,
      startMinute: cook.deliveryWindowStartMinute ?? base.deliveryWindow.startMinute,
      endHour: cook.deliveryWindowEndHour ?? base.deliveryWindow.endHour,
      endMinute: cook.deliveryWindowEndMinute ?? base.deliveryWindow.endMinute,
    },
  };
}

export type MealSettingsRow = {
  mealType: MealPeriod;
  enabled: boolean;
  cutoffHour: number;
  cutoffMinute: number;
  deliveryStartHour: number;
  deliveryStartMinute: number;
  deliveryEndHour: number;
  deliveryEndMinute: number;
};

export function mealScheduleFromRow(row: MealSettingsRow): MealSchedule {
  return {
    mealType: row.mealType,
    enabled: row.mealType === "LUNCH" ? true : row.enabled,
    cutoff: { hour: row.cutoffHour, minute: row.cutoffMinute },
    deliveryWindow: {
      startHour: row.deliveryStartHour,
      startMinute: row.deliveryStartMinute,
      endHour: row.deliveryEndHour,
      endMinute: row.deliveryEndMinute,
    },
  };
}

/** Resolve schedule for a meal from settings rows + optional legacy cook lunch fields. */
export function resolveMealSchedule(
  meal: MealPeriod,
  rows: MealSettingsRow[] | null | undefined,
  legacyCook?: Parameters<typeof lunchScheduleFromLegacyCook>[0],
): MealSchedule {
  const row = rows?.find((r) => r.mealType === meal);
  if (row) return mealScheduleFromRow(row);
  if (meal === "LUNCH" && legacyCook) return lunchScheduleFromLegacyCook(legacyCook);
  return defaultMealSchedule(meal);
}

/** @deprecated Prefer resolveMealSchedule("LUNCH", rows, cook).cutoff */
export function cutoffConfigForCook(cook: {
  lunchCutoffHour?: number | null;
  lunchCutoffMinute?: number | null;
}): CutoffConfig {
  return lunchScheduleFromLegacyCook(cook).cutoff;
}

/** @deprecated Prefer resolveMealSchedule(...).deliveryWindow */
export function deliveryWindowForCook(cook: {
  deliveryWindowStartHour?: number | null;
  deliveryWindowStartMinute?: number | null;
  deliveryWindowEndHour?: number | null;
  deliveryWindowEndMinute?: number | null;
}): DeliveryWindow {
  return lunchScheduleFromLegacyCook(cook).deliveryWindow;
}

export function formatCutoffLabel(config: CutoffConfig): string {
  const h = String(config.hour).padStart(2, "0");
  const m = String(config.minute).padStart(2, "0");
  return `${h}:${m}`;
}

export function assertValidCutoff(hour: number, minute: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("cutoffHour must be 0–23");
  }
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("cutoffMinute must be 0–59");
  }
}

/** Returns true if orders for this meal on serviceDate are still open. */
export function isBeforeCutoff(
  _meal: MealPeriod,
  now: Date,
  serviceDate: string,
  config: CutoffConfig = defaultCutoffConfig(),
): boolean {
  const [y, m, d] = serviceDate.split("-").map(Number);
  const cutoff = new Date(y, m - 1, d, config.hour, config.minute, 0, 0);
  return now.getTime() < cutoff.getTime();
}

export function isAtOrPastCutoff(
  meal: MealPeriod,
  now: Date,
  serviceDate: string,
  config: CutoffConfig,
): boolean {
  return !isBeforeCutoff(meal, now, serviceDate, config);
}

export function serviceDateISO(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseServiceDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) throw new Error("Invalid service date");
  return new Date(y, m - 1, d);
}

export function addDaysISO(iso: string, days: number): string {
  const dt = parseServiceDate(iso);
  dt.setDate(dt.getDate() + days);
  return serviceDateISO(dt);
}

export function dayOfWeekForServiceDate(iso: string): number {
  return parseServiceDate(iso).getDay();
}

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function hhmm(hour: number, minute: number) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function formatDeliveryWindowLabel(window: DeliveryWindow): string {
  return `${hhmm(window.startHour, window.startMinute)}–${hhmm(window.endHour, window.endMinute)}`;
}

export function assertValidDeliveryWindow(window: DeliveryWindow): void {
  assertValidCutoff(window.startHour, window.startMinute);
  assertValidCutoff(window.endHour, window.endMinute);
  const start = window.startHour * 60 + window.startMinute;
  const end = window.endHour * 60 + window.endMinute;
  if (end <= start) {
    throw new Error("Delivery window end must be after start");
  }
}

export function mealLabel(meal: MealPeriod): string {
  if (meal === "BREAKFAST") return "Breakfast";
  if (meal === "DINNER") return "Dinner";
  return "Lunch";
}
