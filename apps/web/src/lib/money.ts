/** Display helper — paise → Indian rupee string (UX-U10). */
export function formatInr(paise: number): string {
  const rupees = Math.round(Number(paise) || 0) / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(rupees);
}

/** Bare number without currency symbol (when ₹ is shown separately). */
export function formatInrAmount(paise: number): string {
  const rupees = Math.round(Number(paise) || 0) / 100;
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(rupees);
}
