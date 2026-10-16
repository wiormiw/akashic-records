import * as v from 'valibot';

// Every variable arrives as a string. These builders coerce one, apply its default (given as the
// string an operator would write), and validate the result. Without a default a key is required.

export const str = (options: { minLength?: number; default?: string } = {}) => {
	const schema = v.pipe(
		v.string('is required'),
		v.minLength(options.minLength ?? 0, 'must not be empty'),
	);
	return options.default === undefined ? schema : v.optional(schema, options.default);
};

export const int = (options: { min?: number; max?: number; default?: number } = {}) => {
	const text = v.string('is required');
	return v.pipe(
		options.default === undefined ? text : v.optional(text, String(options.default)),
		v.transform(Number),
		v.integer('must be an integer'),
		v.minValue(options.min ?? Number.MIN_SAFE_INTEGER, `must be at least ${options.min}`),
		v.maxValue(options.max ?? Number.MAX_SAFE_INTEGER, `must be at most ${options.max}`),
	);
};

export const bool = (fallback: boolean) =>
	v.pipe(
		v.optional(
			v.picklist(['true', 'false', '1', '0'], 'must be true or false'),
			fallback ? 'true' : 'false',
		),
		v.transform((value) => value === 'true' || value === '1'),
	);

export const url = (fallback?: string) => {
	const schema = v.pipe(v.string('is required'), v.url('must be a URL'));
	return fallback === undefined ? schema : v.optional(schema, fallback);
};

/** An optional URL with no default: absent stays undefined. */
export const optionalUrl = () => v.optional(v.pipe(v.string(), v.url('must be a URL')));

// The fallback is its own type parameter, so a key with one is typed as never undefined.
export const oneOfEnv = <
	const T extends readonly [string, ...string[]],
	const F extends T[number] | undefined = undefined,
>(
	values: T,
	fallback?: F,
) => v.optional(v.picklist(values, `must be one of ${values.join(', ')}`), fallback as F);

/** Settings every app needs. Apps spread this into their own `v.object`. */
export const baseEnv = {
	NODE_ENV: oneOfEnv(['development', 'test', 'production'], 'development'),
	LOG_LEVEL: oneOfEnv(['trace', 'debug', 'info', 'warn', 'error', 'fatal'], 'info'),
	OTEL_EXPORTER_OTLP_ENDPOINT: url('http://localhost:4318'),
	OTEL_METRIC_INTERVAL_MS: int({ min: 1000, default: 15000 }),
	// How long in-flight requests get to finish after a stop signal, and the hard limit on the
	// whole shutdown. The second must exceed the first.
	DRAIN_TIMEOUT_MS: int({ min: 0, default: 10000 }),
	SHUTDOWN_TIMEOUT_MS: int({ min: 0, default: 15000 }),
};

/**
 * Parses and validates settings. Throws one message listing every bad key, so an operator fixes
 * the whole `.env` at once rather than one rerun per mistake.
 */
export function loadEnv<S extends v.GenericSchema>(
	schema: S,
	raw: Record<string, string | undefined>,
): v.InferOutput<S> {
	// An empty value (`KEY=` in a .env) means unset, so the key takes its default.
	const present = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
	const parsed = v.safeParse(schema, present, { abortPipeEarly: true });
	if (parsed.success) return parsed.output;

	const problems = new Map<string, string>();
	for (const issue of parsed.issues) {
		const name = v.getDotPath(issue) ?? '(root)';
		// Valibot words an absent key as an object-level "Invalid key"; to an operator it is just unset.
		const absent = issue.type === 'object' && issue.received === 'undefined';
		if (!problems.has(name)) problems.set(name, absent ? 'is required' : issue.message);
	}
	const lines = [...problems].map(([name, message]) => `  ${name}: ${message}`).join('\n');
	throw new Error(`Invalid environment configuration:\n${lines}`);
}

/** Throws when an inner call's timeout can outlive the request waiting on it. */
export function assertNestedBudget(name: string, innerMs: number, outerMs: number): void {
	if (innerMs < outerMs) return;
	throw new Error(
		`Invalid environment configuration:\n  ${name}=${innerMs} is not shorter than ${outerMs}; ` +
			'the outer wait would end before the inner call could fail.',
	);
}
