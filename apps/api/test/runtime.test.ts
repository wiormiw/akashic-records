import { expect, test } from 'bun:test';
import { policy, UPLOAD_BODY_BYTES } from '@/config.ts';
import { listen, MAX_REQUEST_BODY_BYTES, releaseAll, stop } from '@/runtime.ts';

const consumers = (steps: string[]): AsyncDisposable => ({
	async [Symbol.asyncDispose]() {
		steps.push('consumers');
	},
});

test('shutdown drains, aborts, stops the consumers, releases, then stops', async () => {
	const steps: string[] = [];
	await stop({
		reason: 'SIGTERM',
		drainMs: 1000,
		server: { stop: async (force) => void steps.push(force ? 'force-close' : 'stop-accepting') },
		consumers: consumers(steps),
		container: { dispose: async () => void steps.push('dispose') },
		lifecycle: {
			beginDraining: () => steps.push('draining'),
			abort: () => steps.push('abort'),
			markStopped: () => steps.push('stopped'),
		},
	});
	expect(steps).toEqual(['draining', 'stop-accepting', 'abort', 'consumers', 'dispose', 'stopped']);
});

test('in-flight work past the drain window is cut off before release', async () => {
	const steps: string[] = [];
	await stop({
		reason: 'SIGTERM',
		drainMs: 10,
		server: {
			stop: (force) =>
				force ? (steps.push('force-close'), Promise.resolve()) : new Promise<void>(() => {}),
		},
		consumers: consumers(steps),
		container: { dispose: async () => void steps.push('dispose') },
		lifecycle: { beginDraining: () => {}, abort: () => steps.push('abort'), markStopped: () => {} },
	});
	expect(steps).toEqual(['force-close', 'abort', 'consumers', 'dispose']);
});

test('the lifecycle is marked stopped even when release fails', async () => {
	const steps: string[] = [];
	const failed = stop({
		reason: 'SIGTERM',
		drainMs: 1000,
		server: { stop: async () => {} },
		consumers: consumers([]),
		container: {
			dispose: async () => {
				throw new Error('pool would not close');
			},
		},
		lifecycle: {
			beginDraining: () => {},
			abort: () => {},
			markStopped: () => steps.push('stopped'),
		},
	});
	await expect(failed).rejects.toThrow('pool would not close');
	expect(steps).toEqual(['stopped']);
});

/** A served server that records what it publishes and whether it was stopped. */
const served = (steps: string[]) => ({
	published: [] as [string, string][],
	publish(topic: string, payload: string) {
		this.published.push([topic, payload]);
	},
	stop: async (force?: boolean) => void steps.push(force ? 'server-closed' : 'server-stopping'),
});

const relayTo = (steps: string[], fails = false) => ({
	deliver: undefined as ((topic: string, payload: string) => void) | undefined,
	async start(deliver: (topic: string, payload: string) => void) {
		steps.push('relay');
		if (fails) throw new Error('redis refused the subscription');
		this.deliver = deliver;
	},
});

test('a server that cannot listen stops the consumers and releases the graph before the error propagates', async () => {
	const steps: string[] = [];
	const failed = listen({
		serve: (): ReturnType<typeof served> => {
			throw new Error('EADDRINUSE');
		},
		relay: relayTo(steps),
		consumers: consumers(steps),
		container: { dispose: async () => void steps.push('dispose') },
		lifecycle: { abort: () => steps.push('abort') },
	});
	await expect(failed).rejects.toThrow('EADDRINUSE');
	// The relay never starts for a server that isn't there.
	expect(steps).toEqual(['abort', 'consumers', 'dispose']);
});

test('a server that listens is handed back, and the relay delivers to its sockets', async () => {
	const steps: string[] = [];
	const relay = relayTo(steps);
	const server = await listen({
		serve: () => served(steps),
		relay,
		consumers: consumers(steps),
		container: { dispose: async () => void steps.push('dispose') },
		lifecycle: { abort: () => steps.push('abort') },
	});
	expect(steps).toEqual(['relay']);
	// What another instance published reaches this server's subscribers.
	relay.deliver?.('room:r1', 'hello');
	expect(server.published).toEqual([['room:r1', 'hello']]);
});

test('a relay that cannot start closes the server and releases the graph before the error propagates', async () => {
	const steps: string[] = [];
	const failed = listen({
		serve: () => served(steps),
		relay: relayTo(steps, true),
		consumers: consumers(steps),
		container: { dispose: async () => void steps.push('dispose') },
		lifecycle: { abort: () => steps.push('abort') },
	});
	await expect(failed).rejects.toThrow('redis refused the subscription');
	expect(steps).toEqual(['relay', 'abort', 'server-closed', 'consumers', 'dispose']);
});

test('the container is released even when stopping a consumer fails', async () => {
	const steps: string[] = [];
	const failed = stop({
		reason: 'SIGTERM',
		drainMs: 1000,
		server: { stop: async () => {} },
		consumers: {
			async [Symbol.asyncDispose]() {
				throw new Error('channel closed');
			},
		},
		container: { dispose: async () => void steps.push('dispose') },
		lifecycle: {
			beginDraining: () => {},
			abort: () => {},
			markStopped: () => steps.push('stopped'),
		},
	});
	await expect(failed).rejects.toThrow('channel closed');
	expect(steps).toEqual(['dispose', 'stopped']);
});

const disposable = (steps: string[], name: string, fails = false): AsyncDisposable => ({
	async [Symbol.asyncDispose]() {
		steps.push(name);
		if (fails) throw new Error(`${name} would not close`);
	},
});

test('releasing consumers stops every one, in reverse, even past a failure', async () => {
	const steps: string[] = [];
	const all = releaseAll([
		disposable(steps, 'a'),
		disposable(steps, 'b', true),
		disposable(steps, 'c'),
	]);
	await expect(all[Symbol.asyncDispose]()).rejects.toThrow('b would not close');
	expect(steps).toEqual(['c', 'b', 'a']);
});

test('several failures to release are reported together', async () => {
	const steps: string[] = [];
	const all = releaseAll([disposable(steps, 'a', true), disposable(steps, 'b', true)]);
	const failure = await all[Symbol.asyncDispose]().then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(AggregateError);
	expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual([
		'b would not close',
		'a would not close',
	]);
	expect(steps).toEqual(['b', 'a']);
});

test("the server's body ceiling sits above the upload route's own, and holds for chunked bodies", async () => {
	// The upload route answers its own 413 problem first; Bun's bare 413 is only the backstop.
	expect(UPLOAD_BODY_BYTES).toBe(policy.uploads.maxBytes + 64 * 1024);
	expect(MAX_REQUEST_BODY_BYTES).toBe(2 * UPLOAD_BODY_BYTES);

	// A small ceiling stands in for the real one: a chunked body declares no length, so only the
	// server's own count can stop it.
	const server = Bun.serve({
		port: 0,
		maxRequestBodySize: 1024,
		fetch: async (request) => new Response(String((await request.arrayBuffer()).byteLength)),
	});
	try {
		const chunked = (size: number) =>
			new ReadableStream({
				start(controller) {
					controller.enqueue(new Uint8Array(size));
					controller.close();
				},
			});
		const small = await fetch(server.url, { method: 'POST', body: chunked(512) });
		expect(await small.text()).toBe('512');
		const large = await fetch(server.url, { method: 'POST', body: chunked(4096) });
		expect(large.status).toBe(413);
	} finally {
		await server.stop(true);
	}
});
