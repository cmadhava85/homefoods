import type { FastifyInstance } from "fastify";
import type { Db } from "@localmeals/db";
import { serviceDateISO } from "@localmeals/domain";

export async function metaRoutes(app: FastifyInstance, opts: { db: Db }) {
  const { db } = opts;
app.get("/health", async () => ({ ok: true }));

app.get("/meta/today", async () => ({ serviceDate: serviceDateISO() }));

app.get("/meta/features", async () => {
  const { getFeatureFlags } = await import("../services/featureFlags.js");
  try {
    return { flags: await getFeatureFlags(db) };
  } catch {
    const { defaultFeatureFlags } = await import("@localmeals/domain");
    return { flags: defaultFeatureFlags() };
  }
});
}
