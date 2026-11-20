/** Deep-link into a kitchen week view (optionally for “order another day”). */
export function kitchenOrderHref(opts: {
  slug: string;
  mealType?: string | null;
  /** Prior order’s service date — UI jumps to the next free day after this. */
  afterServiceDate?: string | null;
  again?: boolean;
}): string {
  const q = new URLSearchParams();
  const meal = (opts.mealType ?? "").trim().toUpperCase();
  if (meal === "BREAKFAST" || meal === "LUNCH" || meal === "DINNER") {
    q.set("meal", meal.toLowerCase());
  }
  if (opts.afterServiceDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.afterServiceDate)) {
    q.set("after", opts.afterServiceDate);
  }
  if (opts.again) q.set("again", "1");
  const qs = q.toString();
  return qs ? `/kitchen/${opts.slug}?${qs}` : `/kitchen/${opts.slug}`;
}
