/** Soft max so cooks don’t underprice themselves (PRODUCT_DECISIONS). */
export const WEEK_DISCOUNT_PERCENT_MAX = 15;

export type WeekDiscountRule = {
  percent: number;
  minDays: number;
};

export function normalizeWeekDiscountRule(input: {
  percent?: number | null;
  minDays?: number | null;
}): WeekDiscountRule {
  const percent = Math.max(0, Math.min(WEEK_DISCOUNT_PERCENT_MAX, Math.floor(Number(input.percent) || 0)));
  const minDays = Math.max(2, Math.min(14, Math.floor(Number(input.minDays) || 3)));
  return { percent, minDays };
}

export function weekDiscountApplies(dayCount: number, rule: WeekDiscountRule): boolean {
  return rule.percent > 0 && dayCount >= rule.minDays;
}

/**
 * After cancelling part of a week cart, does the discount still hold for what remains?
 * Counts distinct calendar days (B+L+D on one day = 1), same as at checkout.
 */
export function weekDiscountSurvivesCancel(
  remainingServiceDates: string[],
  rule: WeekDiscountRule,
): boolean {
  return weekDiscountApplies(new Set(remainingServiceDates).size, rule);
}

/** Food-only discount for one cart line (delivery + platform fee never discounted). */
export function lineFoodDiscountPaise(input: {
  foodPaise: number;
  qty: number;
  dayCount: number;
  rule: WeekDiscountRule;
}): number {
  if (!weekDiscountApplies(input.dayCount, input.rule)) return 0;
  const food = Math.max(0, input.foodPaise) * Math.max(1, input.qty);
  return Math.floor((food * input.rule.percent) / 100);
}

export function describeWeekDiscount(rule: WeekDiscountRule): string | null {
  if (rule.percent <= 0) return null;
  return `${rule.percent}% off food when you order ≥ ${rule.minDays} days`;
}
