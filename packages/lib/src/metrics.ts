import { metrics } from '@opentelemetry/api';

/** The meter for this service's own instruments. A no-op until telemetry is created. */
export const meter = () => metrics.getMeter('akashic');
