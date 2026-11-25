/** WhatsApp copy for MVP-3 party / bulk catering outbox events (Catering*). */

export type CateringWaMessage = { to: string; body: string; buttons?: string[] };

function s(v: unknown) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function inr(paise: unknown) {
  const n = Number(paise ?? 0);
  return `₹${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}`;
}

const MODE: Record<string, string> = {
  DELIVERY: "Cook delivers",
  PICKUP: "Customer picks up",
  CUSTOMER_ARRANGE: "Customer arranges transport",
};

export function cateringWaMessages(
  eventName: string,
  payload: Record<string, unknown>,
): CateringWaMessage[] {
  const customer = s(payload.customerMobile);
  const cook = s(payload.cookMobile);
  const id = s(payload.publicId);
  const kitchen = s(payload.kitchenName) || "kitchen";
  const what = `${payload.plates ?? "?"}× ${s(payload.comboName) || "party combo"}`;
  const when = `${s(payload.eventDate)} at ${s(payload.eventTime)}`;
  const url = s(payload.bookingUrl);
  const out: CateringWaMessage[] = [];
  const push = (to: string, lines: Array<string | null>, buttons?: string[]) => {
    if (to.length > 5) out.push({ to, body: lines.filter((l) => l !== null).join("\n"), buttons });
  };

  switch (eventName) {
    case "CateringAdvancePaid":
      push(
        customer,
        [
          `🎉 Party order booked · ${kitchen}`,
          `${id} · ${what}`,
          `For ${when}`,
          `Advance received. Balance ${inr(payload.balancePaise)} is due before the event.`,
          url ? `Pay or view: ${url}` : null,
        ],
        ["Orders"],
      );
      push(cook, [
        `🎉 New party order · ${id}`,
        what,
        `${when} · ${MODE[s(payload.fulfillmentMode)] ?? "Delivery"}`,
        `Advance paid — balance ${inr(payload.balancePaise)} due before the event.`,
        "Open your cook desk → Party orders for the address and contact.",
      ]);
      break;
    case "CateringBalancePaid":
      push(customer, [`✅ Fully paid · ${id}`, `${what} · ${when}`, `Total ${inr(payload.totalPaise)}. Enjoy the function!`], ["Orders"]);
      push(cook, [`✅ Balance paid · ${id}`, `${what} · ${when}`, "Fully paid — mark it completed on the desk after delivery."]);
      break;
    case "CateringBalanceDue":
      push(
        customer,
        [
          `⏰ Balance due · ${id}`,
          `${what} · ${when}`,
          `Please pay the balance ${inr(payload.balancePaise)} before the event.`,
          url ? `Pay here: ${url}` : null,
        ],
        ["Orders"],
      );
      break;
    case "CateringCancelled": {
      const refund = Number(payload.refundPaise ?? 0);
      push(
        customer,
        [
          `❎ Party order cancelled · ${id}`,
          `${what} · ${when}`,
          refund > 0
            ? `Refund of ${inr(refund)} initiated — returns to the same UPI/bank (usually a few hours, up to 1–2 working days).`
            : "No payment was taken.",
        ],
        ["Orders"],
      );
      push(cook, [`❎ Party order cancelled · ${id}`, `${what} · ${when}`, `Cancelled by ${s(payload.cancelledBy).toLowerCase() || "admin"}.`]);
      break;
    }
    default:
      break;
  }
  return out;
}
