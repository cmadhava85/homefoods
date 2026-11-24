/**
 * Optional OpenTelemetry bootstrap (traces).
 * Enable with OTEL_ENABLED=true (+ OTEL_EXPORTER_OTLP_ENDPOINT for non-default collector).
 */
export async function startTelemetry(serviceName: string): Promise<() => Promise<void>> {
  const noop = async () => {};
  if (process.env.OTEL_ENABLED !== "true") return noop;

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
    console.info(`[otel] tracing enabled for ${serviceName}`);
    // Flushed by installProcessLifecycle on SIGTERM so spans are not lost on scale-down.
    return shutdown;
  } catch (err) {
    console.error(
      "[otel] failed to start — install OTEL packages or unset OTEL_ENABLED",
      err instanceof Error ? err.message : err,
    );
    return noop;
  }
}
