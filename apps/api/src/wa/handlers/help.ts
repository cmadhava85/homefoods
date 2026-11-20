import { createTicketFromHelp } from "../../services/admin.js";
import type { Locale } from "@localmeals/i18n";
import type { WaSession } from "../session.js";

export async function handleHelp(s: WaSession): Promise<object> {
  const { db, from, text, intent, wa, replies, waSafe, wt } = s;
  let { waLocale } = { waLocale: s.waLocale };
  const setLocale = (v: Locale) => {
    s.waLocale = v;
    waLocale = v;
  };
  void setLocale;
  void waLocale;

  if (intent === "HELP") {
    return await waSafe("HELP", async () => {
      const ticket = await createTicketFromHelp(db, {
        customerMobile: from.startsWith("+") ? from : `+${from}`,
        summary: `WhatsApp help: ${text}`,
      });
      await wa.send({
        to: from,
        body: wt("wa.helpBody", { id: ticket.id }),
        buttons: ["Menu", "Family", "Week csk-homemade-delights"],
      });
      return { ok: true, intent, ticketId: ticket.id, replies: replies() };
    });
  }

  return { ok: true, intent, unhandled: true as const, replies: replies() };
}
