import "./env.js";
import { assertProductionConfig } from "./prodConfig.js";
import { startTelemetry } from "./telemetry.js";
import { buildApp } from "./app.js";
import { closeDb, createDb } from "@localmeals/db";
import { installProcessLifecycle } from "@localmeals/observability";

try {
  assertProductionConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);

const flushTelemetry = await startTelemetry("localmeals-api");

const db = createDb();

if (process.env.NODE_ENV === "production") {
  const { assertSchemaCurrent } = await import("@localmeals/db");
  const { createServiceLogger } = await import("@localmeals/observability");
  const bootLog = createServiceLogger("localmeals-api");
  const schema = await assertSchemaCurrent(db);
  if (!schema.ok && !schema.allowed) {
    bootLog.error(
      {
        event: "schema.behind",
        expected: schema.expected,
        applied: schema.applied,
      },
      "refusing to boot — DB migrations behind this build (ALLOW_SCHEMA_BEHIND=true to override)",
    );
    process.exit(1);
  }
  if (!schema.ok) {
    bootLog.warn(
      { event: "schema.behind", expected: schema.expected, applied: schema.applied },
      "ALLOW_SCHEMA_BEHIND — booting with schema behind code",
    );
  }
}

const app = buildApp(db);
installProcessLifecycle({
  service: "localmeals-api",
  logger: app.log,
  steps: [
    // Stops accepting connections and waits for in-flight requests to finish.
    { name: "http", run: () => app.close() },
    { name: "db", run: () => closeDb(db) },
    { name: "telemetry", run: flushTelemetry },
  ],
});
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`API listening on ${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
