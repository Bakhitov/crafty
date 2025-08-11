// @ts-nocheck
// Keep this file JS-compatible and ESM-safe; avoid TS-only syntax

// Signal to Mastra only when telemetry is enabled by env
try {
  // @ts-ignore
  const enabled = String(process.env.TELEMETRY_ENABLED || '').toLowerCase();
  // truthy values: '1', 'true', 'yes', 'on'
  const isOn = enabled === '1' || enabled === 'true' || enabled === 'yes' || enabled === 'on';
  if (isOn) {
    // @ts-ignore
    globalThis.___MASTRA_TELEMETRY___ = true;
  }
} catch {}

// This function will be picked up by Mastra CLI and bundled to .mastra/output/instrumentation.mjs
// It enables OpenTelemetry tracing using OTLP exporter. Endpoint/headers are read from env:
// - OTEL_EXPORTER_OTLP_ENDPOINT
// - OTEL_EXPORTER_OTLP_HEADERS
export async function register() {
  // Read flag early; if disabled, do nothing
  try {
    const enabled = String(process.env.TELEMETRY_ENABLED || '').toLowerCase();
    const isOn = enabled === '1' || enabled === 'true' || enabled === 'yes' || enabled === 'on';
    if (!isOn) return;
  } catch {}
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


