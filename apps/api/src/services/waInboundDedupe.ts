import { eq } from "drizzle-orm";
import { waInboundDedupe, type Db } from "@localmeals/db";

/**
 * Process a Meta inbound message at most once. The wamid row is the claim; if processing throws,
 * the claim is released so Meta's redelivery (after our non-2xx) is handled instead of being
 * dropped as a "duplicate".
 */
export async function processWaInboundOnce<T>(
  db: Db,
  message: { wamid?: string; from: string },
  handler: () => Promise<T>,
): Promise<{ duplicate: true } | { duplicate: false; result: T }> {
  const wamid = message.wamid?.slice(0, 128);
  if (!wamid) return { duplicate: false, result: await handler() };

  const inserted = await db
    .insert(waInboundDedupe)
    .values({ wamid, fromMobile: message.from.slice(0, 15) })
    .onConflictDoNothing()
    .returning({ wamid: waInboundDedupe.wamid });
  if (!inserted.length) return { duplicate: true };

  try {
    return { duplicate: false, result: await handler() };
  } catch (err) {
    await db
      .delete(waInboundDedupe)
      .where(eq(waInboundDedupe.wamid, wamid))
      .catch(() => undefined);
    throw err;
  }
}
