import { outbox, type Db } from "@localmeals/db";
import { withCorr } from "@localmeals/observability";
import { outboxWaker } from "./outboxWake.js";

/** Drizzle db or transaction — anything with `.insert(outbox)`. */
type OutboxExecutor = Pick<Db, "insert">;

/**
 * Enqueue an outbox row with request correlation (`_corr`) for worker log joining.
 */
export async function enqueueOutbox(
  executor: OutboxExecutor,
  eventName: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await executor.insert(outbox).values({
    eventName,
    payload: withCorr(payload),
  });
  outboxWaker().markDirty();
}
