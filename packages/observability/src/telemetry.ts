/**
 * Optional OpenTelemetry bootstrap (traces).
 * Enable with OTEL_ENABLED=true (+ OTEL_EXPORTER_OTLP_ENDPOINT for non-default collector).
 */
export async function startTelemetry(serviceName: string): Promise<void> {
  if (process.env.OTEL_ENABLED !== "true") return;

  try {
    const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }] =
      await Promise.all([
        import("@opentelemetry/sdk-node"),
        import("@opentelemetry/auto-instrumentations-node"),
        import("@opentelemetry/exporter-trace-otlp-http"),
      ]);

    const exporter = new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || undefined,
    });

    const sdk = new NodeSDK({
      serviceName,
      traceExporter: exporter,
      instrumentations: [
        getNodeAutoInstrumentations({
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });

    await sdk.start();
    const shutdown = async () => {
      try {
        await sdk.shutdown();
      } catch (err) {
        console.error("[otel] shutdown failed", err);
      }
    };
    process.once("SIGTERM", () => void shutdown());
    process.once("SIGINT", () => void shutdown());
    console.info(`[otel] tracing enabled for ${serviceName}`);
  } catch (err) {
    console.error(
      "[otel] failed to start — install OTEL packages or unset OTEL_ENABLED",
      err instanceof Error ? err.message : err,
    );
  }
}
