import "./env.js";
import { assertProductionConfig } from "./prodConfig.js";
import { startTelemetry } from "./telemetry.js";
import { buildApp } from "./app.js";

try {
  assertProductionConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);

process.on("unhandledRejection", (reason) => {
  console.error("[api] unhandledRejection", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[api] uncaughtException", err);
});

await startTelemetry("localmeals-api");

const app = buildApp();
app
  .listen({ port, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`API listening on ${port}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
