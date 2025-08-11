// @ts-nocheck
// Keep this file JS-compatible and ESM-safe; avoid TS-only syntax

// Signal to Mastra that telemetry is intentionally enabled via custom instrumentation
try {
  // Mark telemetry as intentionally enabled to silence Mastra warning
  // Note: keep this file pure JS-compatible (no TS-only syntax)
  // @ts-ignore
  globalThis.___MASTRA_TELEMETRY___ = true;
} catch {}

// This function will be picked up by Mastra CLI and bundled to .mastra/output/instrumentation.mjs
// It enables OpenTelemetry tracing using OTLP exporter. Endpoint/headers are read from env:
// - OTEL_EXPORTER_OTLP_ENDPOINT
// - OTEL_EXPORTER_OTLP_HEADERS
export async function register() {
  try {
    const sdkNode = await import('@opentelemetry/sdk-node');
    const auto = await import('@opentelemetry/auto-instrumentations-node');
    const otlp = await import('@opentelemetry/exporter-trace-otlp-http');

    const { NodeSDK } = sdkNode;
    const { getNodeAutoInstrumentations } = auto;
    const { OTLPTraceExporter } = otlp;

    if (!NodeSDK || !OTLPTraceExporter || !getNodeAutoInstrumentations) return;

    const exporter = new OTLPTraceExporter();
    const sdk = new NodeSDK({
      traceExporter: exporter,
      instrumentations: [getNodeAutoInstrumentations()],
    });

    await sdk.start().catch((err) => {
      console.error('Failed to start OpenTelemetry SDK:', err);
    });
  } catch {
    // Dependencies not installed; skip silently
    return;
  }
}


