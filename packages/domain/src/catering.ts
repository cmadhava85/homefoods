/**
 * MVP-3 party / bulk catering rules. Separate from the lunch order state machine:
 * a booking is one combo × N plates for one event, paid as 50% advance + 50% balance.
 */
import { appZoneDateTime, serviceDateISO, addDaysISO } from "./cutoff.js";
import { DomainError } from "./errors.js";
import { PLATFORM_FEE_PAISE } from "./money.js";

/** Smallest MOQ a cook may set — below this it is a lunch order, not catering. */
export const CATERING_MIN_MOQ = 10;
/** Largest single booking for the first slice (banquet / 200+ plates is out of scope). */
export const CATERING_MAX_PLATES = 150;
/** Cook-configurable cut-off bounds (hours before the event start). */
export const CATERING_CUTOFF_HOURS_MIN = 48;
export const CATERING_CUTOFF_HOURS_MAX = 72;
export const CATERING_DEFAULT_CUTOFF_HOURS = 48;
/** Default per-day plate cap across all bookings for one kitchen. */
export const CATERING_DEFAULT_DAILY_PLATE_CAP = 100;
/** How far ahead an event can be booked. */
export const CATERING_MAX_DAYS_AHEAD = 60;
/** Advance share of food, in basis points (50%). */
export const CATERING_ADVANCE_BPS = 5_000;
/** Event start must fall inside this local wall-clock range. */
export const CATERING_EVENT_EARLIEST_HOUR = 6;
export const CATERING_EVENT_LATEST_HOUR = 22;

export const CATERING_STATUSES = [
  "AWAITING_ADVANCE",
  "ADVANCE_PAID",
  "PAID",
  "COMPLETED",
  "CANCELLED",
] as const;
export type CateringStatus = (typeof CATERING_STATUSES)[number];

export type CateringPaymentPhase = "ADVANCE" | "BALANCE";

const TRANSITIONS: Record<CateringStatus, CateringStatus[]> = {
  AWAITING_ADVANCE: ["ADVANCE_PAID", "CANCELLED"],
  ADVANCE_PAID: ["PAID", "CANCELLED"],
  PAID: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function canCateringTransition(from: CateringStatus, to: CateringStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertCateringTransition(from: CateringStatus, to: CateringStatus): void {
  if (!canCateringTransition(from, to)) {
    throw DomainError.conflict(`Booking cannot move from ${from} to ${to}`);
  }
}

/** Which payment is due now (null = nothing to pay). */
export function cateringDuePhase(status: CateringStatus): CateringPaymentPhase | null {
  if (status === "AWAITING_ADVANCE") return "ADVANCE";
  if (status === "ADVANCE_PAID") return "BALANCE";
  return null;
}

export type CateringAmounts = {
  foodPaise: number;
  platformFeePaise: number;
  totalPaise: number;
  /** Charged on the advance link: 50% of food (rounded up) + platform fee. */
  advancePaise: number;
  /** Charged on the balance link: remaining food. */
  balancePaise: number;
};

/** Split a booking into advance + balance. The ₹7 platform fee is charged once, with the advance. */
export function cateringAmounts(input: {
  pricePerPlatePaise: number;
  plates: number;
  platformFeePaise?: number;
}): CateringAmounts {
  const foodPaise = Math.max(0, Math.round(input.pricePerPlatePaise)) * Math.max(0, input.plates);
  const platformFeePaise = input.platformFeePaise ?? PLATFORM_FEE_PAISE;
  const advanceFood = Math.ceil((foodPaise * CATERING_ADVANCE_BPS) / 10_000);
  return {
    foodPaise,
    platformFeePaise,
    totalPaise: foodPaise + platformFeePaise,
    advancePaise: advanceFood + platformFeePaise,
    balancePaise: foodPaise - advanceFood,
  };
}

export function parseEventTime(raw: string): { hour: number; minute: number } {
  const m = /^(\d{2}):(\d{2})$/.exec(raw ?? "");
  const hour = m ? Number(m[1]) : NaN;
  const minute = m ? Number(m[2]) : NaN;
  if (!m || hour > 23 || minute > 59) {
    throw new DomainError("Event time must be HH:MM", 400, "catering_event_time");
  }
  if (hour < CATERING_EVENT_EARLIEST_HOUR || hour > CATERING_EVENT_LATEST_HOUR) {
    throw new DomainError(
      `Event time must be between ${String(CATERING_EVENT_EARLIEST_HOUR).padStart(2, "0")}:00 and ${CATERING_EVENT_LATEST_HOUR}:00`,
      400,
      "catering_event_time",
    );
  }
  return { hour, minute };
}

/** Absolute event start (Asia/Kolkata wall clock). */
export function cateringEventStartAt(eventDate: string, eventTime: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
    throw new DomainError("Event date must be YYYY-MM-DD", 400, "catering_event_date");
  }
  const { hour, minute } = parseEventTime(eventTime);
  return appZoneDateTime(eventDate, hour, minute);
}

/** Last moment a booking can be placed / self-cancelled. */
export function cateringCutoffAt(eventDate: string, eventTime: string, cutoffHours: number): Date {
  return new Date(cateringEventStartAt(eventDate, eventTime).getTime() - cutoffHours * 3_600_000);
}

export function assertCateringCutoffHours(hours: number): void {
  if (
    !Number.isInteger(hours) ||
    hours < CATERING_CUTOFF_HOURS_MIN ||
    hours > CATERING_CUTOFF_HOURS_MAX
  ) {
    throw new DomainError(
      `Catering cut-off must be ${CATERING_CUTOFF_HOURS_MIN}–${CATERING_CUTOFF_HOURS_MAX} hours`,
      400,
      "catering_cutoff_hours",
    );
  }
}

export function assertCateringCombo(input: {
  name: string;
  pricePerPlatePaise: number;
  minPlates: number;
  maxPlates: number;
}): void {
  if (!input.name.trim()) throw new DomainError("Combo name is required", 400, "catering_combo");
  if (!Number.isInteger(input.pricePerPlatePaise) || input.pricePerPlatePaise < 100) {
    throw new DomainError("Price per plate must be at least ₹1", 400, "catering_combo");
  }
  if (!Number.isInteger(input.minPlates) || input.minPlates < CATERING_MIN_MOQ) {
    throw new DomainError(`Minimum plates must be at least ${CATERING_MIN_MOQ}`, 400, "catering_combo");
  }
  if (
    !Number.isInteger(input.maxPlates) ||
    input.maxPlates < input.minPlates ||
    input.maxPlates > CATERING_MAX_PLATES
  ) {
    throw new DomainError(
      `Maximum plates must be between the minimum and ${CATERING_MAX_PLATES}`,
      400,
      "catering_combo",
    );
  }
}

export type CateringBookableInput = {
  plates: number;
  minPlates: number;
  maxPlates: number;
  eventDate: string;
  eventTime: string;
  cutoffHours: number;
  /** Plates already held/booked by this kitchen on eventDate (excluding this booking). */
  bookedPlatesOnDate: number;
  dailyPlateCap: number;
  now?: Date;
};

/** All the checks a new booking (or a fresh advance link) must pass. */
export function assertCateringBookable(input: CateringBookableInput): void {
  const now = input.now ?? new Date();
  if (!Number.isInteger(input.plates) || input.plates < input.minPlates) {
    throw new DomainError(`Minimum order is ${input.minPlates} plates`, 400, "catering_moq");
  }
  if (input.plates > input.maxPlates) {
    throw new DomainError(`This combo allows up to ${input.maxPlates} plates`, 400, "catering_max");
  }
  const lastDay = addDaysISO(serviceDateISO(now), CATERING_MAX_DAYS_AHEAD);
  if (input.eventDate > lastDay) {
    throw new DomainError(
      `Events can be booked up to ${CATERING_MAX_DAYS_AHEAD} days ahead`,
      400,
      "catering_too_far",
    );
  }
  const cutoff = cateringCutoffAt(input.eventDate, input.eventTime, input.cutoffHours);
  if (now.getTime() >= cutoff.getTime()) {
    throw new DomainError(
      `Party orders need ${input.cutoffHours} hours notice for this kitchen`,
      400,
      "catering_cutoff",
    );
  }
  const left = input.dailyPlateCap - input.bookedPlatesOnDate;
  if (input.plates > left) {
    throw new DomainError(
      left > 0
        ? `Kitchen can take only ${left} more party plates on ${input.eventDate}`
        : `Kitchen is fully booked for parties on ${input.eventDate}`,
      409,
      "catering_capacity",
    );
  }
}

/**
 * Customer self-cancel: free before the advance; full refund up to the cut-off
 * (the cook has not bought bulk ingredients yet). After the cut-off → support only.
 */
export function customerCanCancelCatering(
  status: CateringStatus,
  cutoffAt: Date,
  now = new Date(),
): boolean {
  if (status === "AWAITING_ADVANCE") return true;
  if (status === "ADVANCE_PAID" || status === "PAID") return now.getTime() < cutoffAt.getTime();
  return false;
}
