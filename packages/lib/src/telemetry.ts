import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
	ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { owned } from './lifecycle.ts';

export interface TelemetryOptions {
	serviceName: string;
	environment: string;
	endpoint: string;
	metricIntervalMs: number;
	/** How long disposal waits for the final flush. Default 3000. */
	flushTimeoutMs?: number;
}

/**
 * Runs `flush`, giving up after `timeoutMs`; never throws. With the collector down an export
 * waits out its own retries (about 8s), which would eat most of the shutdown deadline.
 */
export async function boundedFlush(flush: () => Promise<void>, timeoutMs: number): Promise<void> {
	let timer: Timer | undefined;
	const giveUp = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, timeoutMs);
	});
	try {
		await Promise.race([flush().catch(() => undefined), giveUp]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Registers the global tracer and meter providers and starts exporting. The container creates
 * this right after config and disposes it last, so spans recorded during shutdown are flushed.
 *
 * No instrumentations are configured, so nothing is patched and nothing needs a `--preload`:
 * spans come from our own `traced` calls, and the OTel API's proxy tracer picks up the provider
 * whenever this runs.
 */
export function createTelemetry(options: TelemetryOptions): AsyncDisposable {
	const sdk = new NodeSDK({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: options.serviceName,
			[ATTR_SERVICE_VERSION]: Bun.env.npm_package_version ?? '0.0.0',
			[ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
		}),
		traceExporter: new OTLPTraceExporter({ url: `${options.endpoint}/v1/traces` }),
		// Pushed to the Collector rather than scraped: a short-lived pod still reports.
		metricReaders: [
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({ url: `${options.endpoint}/v1/metrics` }),
				exportIntervalMillis: options.metricIntervalMs,
			}),
		],
	});

	sdk.start();

	// Never block exit on a telemetry flush.
	return owned({}, () => boundedFlush(() => sdk.shutdown(), options.flushTimeoutMs ?? 3000));
}
