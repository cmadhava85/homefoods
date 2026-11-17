import { findCookByMobile } from "../../services/cookOps.js";
import type { WaSession } from "../session.js";

export async function handleUnknown(s: WaSession): Promise<object> {
  const { db, from, intent, wa, mobile, replies, waSafe, wt } = s;

  return await waSafe("UNKNOWN", async () => {
    const cookSender = await findCookByMobile(db, mobile);
    await wa.send({
      to: from,
      body: cookSender
        ? [
            `👩‍🍳 ${cookSender.kitchenName} — WhatsApp kitchen`,
            "Status — paid queue + late / cancel waiting",
            "Late requests · Cancel requests — Accept / Decline",
            "Add Sambar rice 80 — post today’s lunch",
            "Cooking → Packed → Dispatched · Delivered LM-…",
          ].join("\n")
        : wt("wa.unknownCustomer"),
      buttons: cookSender
        ? ["Status", "Cancel requests", "My menu"]
        : ["Menu", "Orders", "Week sri-sai"],
    });
    return { ok: true, intent: "UNKNOWN", replies: replies() };
  });
}
