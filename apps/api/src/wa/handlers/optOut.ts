import type { WaSession } from "../session.js";

/** STOP / START — marketing opt-out (menu alerts). Order updates still send. */
export async function handleOptOut(s: WaSession): Promise<object> {
  const { db, from, intent, wa, mobile, replies, wt } = s;
  const { setWaMarketingOptOut } = await import("../../services/profile.js");

  if (intent === "STOP") {
    await setWaMarketingOptOut(db, mobile, true);
    await wa.send({
      to: from,
      body: wt("wa.optOutDone"),
      buttons: ["Menu", "Orders", "Help"],
    });
    return { ok: true, intent: "STOP", optedOut: true, replies: replies() };
  }

  await setWaMarketingOptOut(db, mobile, false);
  await wa.send({
    to: from,
    body: wt("wa.optInDone"),
    buttons: ["Menu", "Orders", "Help"],
  });
  return { ok: true, intent: "START", optedOut: false, replies: replies() };
}
