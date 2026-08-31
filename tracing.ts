import 'dotenv/config';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const dtEndpoint = process.env.DT_ENV_URL || 'https://act53954.sprint.dynatracelabs.com';
const dtToken = process.env.DT_API_TOKEN!;

const headers = { Authorization: `Api-Token ${dtToken}` };

const sdk = new NodeSDK({
  serviceName: 'dynatrace-weather-app',
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({
    url: `${dtEndpoint}/api/v2/otlp/v1/traces`,
    headers,
  }))],
  metricReaders: [new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${dtEndpoint}/api/v2/otlp/v1/metrics`,
      headers,
    }),
    exportIntervalMillis: 15000,
  })],
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        ignoreOutgoingRequestHook: (req) =>
          (req as any).hostname?.includes('dynatracelabs.com') ?? false,
      },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown());
process.on('SIGINT', () => sdk.shutdown());
