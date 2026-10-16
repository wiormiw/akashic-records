import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@akashic/lib/log';
import { captureLogger } from '@akashic/lib/testing';
import { createLifecycle } from '@akashic/lib/lifecycle';
import { systemClock } from '@akashic/lib/time';
import { abortableSleep, createOutbox, runDispatcher } from '../src/dispatcher.ts';

// The dispatcher's pacing, with drain and sleep scripted: nothing touches a database or a clock.
// Each drain takes the next step; the run stops once the script is spent.
type Step = number | Error;

async function run(steps: Step[], options: { abortOnError?: boolean } = {}) {
	const controller = new AbortController();
	const slept: number[] = [];
	let drained = 0;

	await runDispatcher({
		drain: async () => {
			const step = steps[drained++];
			if (drained >= steps.length && !(step instanceof Error && options.abortOnError)) {
				controller.abort();
			}
			if (step instanceof Error) {
				if (options.abortOnError) controller.abort();
				throw step;
			}
			return step ?? 0;
		},
		sleep: async (ms) => void slept.push(ms),
		signal: controller.signal,
		batchSize: 10,
		pollMs: 1000,
		log: silentLogger(),
	});

	return { drained, slept };
}

describe('outbox dispatcher', () => {
	test('drains again at once after a full batch, and sleeps a poll after a partial one', async () => {
		expect(await run([10, 10, 3])).toEqual({ drained: 3, slept: [1000] });
	});

	test('backs off five polls after a failure, capped at ten seconds', async () => {
		expect(await run([new Error('db down'), 0])).toEqual({ drained: 2, slept: [5000, 1000] });
	});

	test('stops without backing off when the failure is the shutdown itself', async () => {
		expect(await run([new Error('aborted')], { abortOnError: true })).toEqual({
			drained: 1,
			slept: [],
		});
	});
});

describe('outbox dispatcher start', () => {
	test('retries prepare, backing off, and drains only once it succeeds', async () => {
		const controller = new AbortController();
		const order: string[] = [];
		let attempts = 0;
		await runDispatcher({
			prepare: async () => {
				attempts++;
				order.push(`prepare ${attempts}`);
				if (attempts < 3) throw new Error('broker not there yet');
			},
			drain: async () => {
				order.push('drain');
				controller.abort();
				return 0;
			},
			sleep: async (ms) => void order.push(`sleep ${ms}`),
			signal: controller.signal,
			batchSize: 10,
			pollMs: 1000,
			log: silentLogger(),
		});
		expect(order).toEqual([
			'prepare 1',
			'sleep 5000',
			'prepare 2',
			'sleep 5000',
			'prepare 3',
			'drain',
			'sleep 1000',
		]);
	});

	test('logs the retention in force once, at info, when it starts', async () => {
		const { logger, lines } = captureLogger();
		await runDispatcher({
			drain: async () => 0,
			sleep: async () => {},
			signal: AbortSignal.abort(),
			batchSize: 10,
			pollMs: 1000,
			retentionDays: 7,
			log: logger,
		});
		const started = lines.filter((line) => line['msg'] === 'dispatcher started');
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ level: 30, retentionDays: 7 });
	});
});

describe('abortableSleep', () => {
	test('leaves no listener behind on the long-lived signal, however many sleeps', async () => {
		const real = new AbortController().signal;
		let added = 0;
		let removed = 0;
		const counting = new Proxy(real, {
			get(target, key) {
				if (key === 'addEventListener') {
					return (...args: Parameters<AbortSignal['addEventListener']>) => {
						added++;
						return target.addEventListener(...args);
					};
				}
				if (key === 'removeEventListener') {
					return (...args: Parameters<AbortSignal['removeEventListener']>) => {
						removed++;
						return target.removeEventListener(...args);
					};
				}
				const value = Reflect.get(target, key, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});

		for (let i = 0; i < 200; i++) await abortableSleep(counting, 0);
		expect(added).toBe(200);
		expect(added - removed).toBe(0);
	});

	test('returns at once when the signal is already aborted', async () => {
		const started = performance.now();
		await abortableSleep(AbortSignal.abort(), 5000);
		expect(performance.now() - started).toBeLessThan(100);
	});

	test('an abort during the sleep ends it early', async () => {
		const controller = new AbortController();
		const started = performance.now();
		const sleeping = abortableSleep(controller.signal, 5000);
		controller.abort();
		await sleeping;
		expect(performance.now() - started).toBeLessThan(100);
	});
});

describe('outbox shutdown', () => {
	test('disposing after the signal aborted mid-drain returns well under a poll', async () => {
		const lifecycle = createLifecycle(silentLogger());
		const outbox = createOutbox({
			// The shutdown lands while a claim is in flight, so the loop reaches its sleep already aborted.
			store: {
				async claim() {
					lifecycle.abort('test');
					return [];
				},
				async finish() {
					return true;
				},
				async prune() {
					return 0;
				},
			},
			transport: async () => {},
			clock: systemClock,
			lifecycle,
			logger: silentLogger(),
			batchSize: 10,
			pollMs: 5000,
			concurrency: 1,
			sendTimeoutMs: 1000,
			retentionDays: 7,
		});
		outbox.start();

		const started = performance.now();
		await outbox[Symbol.asyncDispose]();
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

describe('outbox shutdown while preparing', () => {
	test('a prepare that never settles does not hold disposal open', async () => {
		const lifecycle = createLifecycle(silentLogger());
		let prepared = false;
		const outbox = createOutbox({
			store: {
				async claim() {
					return [];
				},
				async finish() {
					return true;
				},
				async prune() {
					return 0;
				},
			},
			transport: async () => {},
			clock: systemClock,
			lifecycle,
			logger: silentLogger(),
			batchSize: 10,
			pollMs: 5000,
			concurrency: 1,
			sendTimeoutMs: 1000,
			retentionDays: 7,
		});
		// As rabbitmq-client's channel acquisition is, with the broker unreachable.
		outbox.start({ prepare: () => ((prepared = true), new Promise<void>(() => {})) });
		await Bun.sleep(10);
		expect(prepared).toBe(true);

		const started = performance.now();
		await outbox[Symbol.asyncDispose]();
		expect(performance.now() - started).toBeLessThan(100);
	});
});
