// @ts-nocheck

// Enable Mastra telemetry when TELEMETRY_ENABLED is truthy
try {
  const enabled = String(process.env.TELEMETRY_ENABLED || '').toLowerCase();
  const isOn = enabled === '1' || enabled === 'true' || enabled === 'yes' || enabled === 'on';
  if (isOn) {
    // @ts-ignore
    globalThis.___MASTRA_TELEMETRY___ = true;
  }
} catch {}

export async function register() {
  try {
    const enabled = String(process.env.TELEMETRY_ENABLED || '').toLowerCase();
    const isOn = enabled === '1' || enabled === 'true' || enabled === 'yes' || enabled === 'on';
    if (!isOn) return;
  } catch {}
  try {
    const sdkNode = await import('@opentelemetry/sdk-node');
    const auto = await import('@opentelemetry/auto-instrumentations-node');
    const otlp = await import('@opentelemetry/exporter-trace-otlp-http');
    const { NodeSDK } = sdkNode as any;
    const { getNodeAutoInstrumentations } = auto as any;
    const { OTLPTraceExporter } = otlp as any;
    if (!NodeSDK || !OTLPTraceExporter || !getNodeAutoInstrumentations) return;
    const exporter = new OTLPTraceExporter();
    const sdk = new NodeSDK({ traceExporter: exporter, instrumentations: [getNodeAutoInstrumentations()] });
    await sdk.start().catch(() => {});
  } catch {}
}


