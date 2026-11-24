import type { Db } from "@localmeals/db";
import { drainOutboxOnce, type DrainOutboxOptions } from "./drainOutbox.js";

/**
 * Push mode: one wake drains every pending batch (bounded by `budgetMs`) so the instance can go
 * idle afterwards. Rows not finished within the budget stay leased/pending for the next wake.
 */
export async function drainUntilEmpty(
  db: Db,
  opts: DrainOutboxOptions = {},
  budgetMs = 45_000,
): Promise<{ claimed: number; batches: number; exhausted: boolean }> {
  const deadline = Date.now() + budgetMs;
  let claimed = 0;
  let batches = 0;
  while (Date.now() < deadline) {
    const r = await drainOutboxOnce(db, opts);
    if (r.claimed === 0) return { claimed, batches, exhausted: true };
    claimed += r.claimed;
    batches += 1;
  }
  return { claimed, batches, exhausted: false };
}
