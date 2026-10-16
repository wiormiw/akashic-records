import { beforeEach, describe, expect, test } from 'bun:test';
import { SpanStatusCode } from '@opentelemetry/api';
import { DuplicateSlug, ErrorCode, RealmNotFound, fail } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { currentTraceparent, traced, withConsumerSpan } from '@akashic/lib/tracing';
import { recordSpans } from '@akashic/lib/testing';

const recorder = recordSpans();

/** What a span carries out of the process. The span object itself is cyclic. */
const exported = (span: ReturnType<typeof recorder.spans>[number] | undefined) =>
	JSON.stringify({ attributes: span?.attributes, events: span?.events, status: span?.status });
beforeEach(() => recorder.reset());

describe('traced', () => {
	test('ends the span with its attributes on success', async () => {
		expect(await traced('authz.check', { 'akashic.realm.id': 'r1' }, async () => 7)).toBe(7);
		const [span] = recorder.spans();
		expect(span?.name).toBe('authz.check');
		expect(span?.attributes['akashic.realm.id']).toBe('r1');
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	test('a returned err marks the span with its code, without throwing', async () => {
		const result = await traced('realm.approve', {}, async () =>
			err(fail.conflict(ErrorCode.realm.duplicateSlug, 'Taken.')),
		);
		expect(result.ok).toBe(false);
		const [span] = recorder.spans();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['akashic.error.code']).toBe('realm.duplicate_slug');
	});

	test('an error class is recognised as a failed result, and its type survives', async () => {
		const refuse = async (): Promise<Result<number, DuplicateSlug | RealmNotFound>> =>
			err(new DuplicateSlug('Taken.'));
		const result: Result<number, DuplicateSlug | RealmNotFound> = await traced(
			'realm.found',
			{},
			refuse,
		);
		expect(result.ok).toBe(false);
		expect(recorder.spans()[0]?.attributes['akashic.error.code']).toBe('realm.duplicate_slug');
	});

	test('a throw is recorded and rethrown', async () => {
		await expect(
			traced('mail.send', {}, async () => {
				throw new Error('down');
			}),
		).rejects.toThrow('down');
		expect(recorder.spans()[0]?.events[0]?.name).toBe('exception');
	});

	test("an AbortError is cancelled once the work's signal has aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error('shutting down: SIGTERM'));
		const reason = new DOMException('stop', 'AbortError');
		await expect(
			traced(
				'authz.check',
				{},
				async () => {
					throw reason;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(reason);
		const [span] = recorder.spans();
		expect(span?.attributes['akashic.cancelled']).toBe(true);
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	test('an AbortError with no aborted signal behind it is an error', async () => {
		const reason = new DOMException('stop', 'AbortError');
		const live = new AbortController();
		for (const signal of [undefined, live.signal]) {
			await expect(
				traced(
					'x',
					{},
					async () => {
						throw reason;
					},
					{ signal },
				),
			).rejects.toBe(reason);
		}
		for (const span of recorder.spans()) {
			expect(span.attributes['akashic.cancelled']).toBeUndefined();
			expect(span.status.code).toBe(SpanStatusCode.ERROR);
			expect(span.attributes['error.type']).toBe('AbortError');
		}
	});

	test('a TimeoutError is an error of type timeout, with or without its signal', async () => {
		const reason = new DOMException('late', 'TimeoutError');
		const controller = new AbortController();
		controller.abort(reason);
		const late = async () => {
			throw reason;
		};
		await expect(traced('x', {}, late, { signal: controller.signal })).rejects.toBe(reason);
		await expect(traced('y', {}, late)).rejects.toBe(reason);
		expect(recorder.spans()).toHaveLength(2);
		for (const span of recorder.spans()) {
			expect(span.status.code).toBe(SpanStatusCode.ERROR);
			expect(span.attributes['error.type']).toBe('timeout');
			expect(span.attributes['akashic.cancelled']).toBeUndefined();
		}
	});

	test('an AbortError raised because a deadline ended is a timeout too', async () => {
		const controller = new AbortController();
		controller.abort(new DOMException('late', 'TimeoutError'));
		const aborted = new DOMException('aborted', 'AbortError');
		await expect(
			traced(
				'x',
				{},
				async () => {
					throw aborted;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(aborted);
		const [span] = recorder.spans();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['error.type']).toBe('timeout');
	});

	test('a shutdown abort is cancelled, not an error', async () => {
		const reason = new Error('shutting down: SIGTERM');
		const controller = new AbortController();
		controller.abort(reason);
		await expect(
			traced(
				'x',
				{},
				async () => {
					throw controller.signal.reason;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(reason);
		const [span] = recorder.spans();
		expect(span?.attributes['akashic.cancelled']).toBe(true);
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
		expect(span?.events).toEqual([]);
	});

	test("an unexpected error's message is not recorded, only its name and code", async () => {
		const pgError = Object.assign(
			new Error(
				'duplicate key value violates unique constraint "user_email_key": (email)=(ann@example.test)',
			),
			{ code: '23505' },
		);
		await expect(
			traced('x', {}, async () => {
				throw pgError;
			}),
		).rejects.toBe(pgError);
		const [span] = recorder.spans();
		expect(exported(span)).not.toContain('ann@example.test');
		expect(span?.attributes['error.type']).toBe('23505');
		expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: '23505' });
	});

	test('an AppError keeps its message: it was written for clients', async () => {
		const failure = fail.external(ErrorCode.common.timeout, 'The request took too long.');
		await expect(
			traced('x', {}, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		const [span] = recorder.spans();
		expect(span?.events[0]?.attributes?.['exception.message']).toBe('The request took too long.');
		expect(span?.attributes['error.type']).toBe(ErrorCode.common.timeout);
	});

	test("a throw that is not the signal's reason is an error even once the signal aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error('shutting down: SIGTERM'));
		const other = new TypeError('boom');
		await expect(
			traced(
				'x',
				{},
				async () => {
					throw other;
				},
				{ signal: controller.signal },
			),
		).rejects.toBe(other);
		const [span] = recorder.spans();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['error.type']).toBe('TypeError');
	});

	test('an ok value passes through untouched', async () => {
		expect(await traced('x', {}, async () => ok(1))).toEqual(ok(1));
	});
});

describe('withConsumerSpan', () => {
	test('a handler that timed out is an error of type timeout', async () => {
		const controller = new AbortController();
		const reason = new DOMException('late', 'TimeoutError');
		controller.abort(reason);
		await expect(
			withConsumerSpan(
				'consume x',
				undefined,
				async () => {
					throw reason;
				},
				{},
				controller.signal,
			),
		).rejects.toBe(reason);
		const [span] = recorder.spans();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
		expect(span?.attributes['error.type']).toBe('timeout');
	});

	test("an AbortError while shutdown hasn't begun is the handler's error", async () => {
		const shutdown = new AbortController();
		const aborted = new DOMException('aborted', 'AbortError');
		await expect(
			withConsumerSpan(
				'consume x',
				undefined,
				async () => {
					throw aborted;
				},
				{},
				shutdown.signal,
			),
		).rejects.toBe(aborted);
		const [span] = recorder.spans();
		expect(span?.attributes['akashic.cancelled']).toBeUndefined();
		expect(span?.status.code).toBe(SpanStatusCode.ERROR);
	});

	test('a handler stopped by shutdown is cancelled, not an error', async () => {
		const controller = new AbortController();
		const reason = new Error('shutting down: SIGTERM');
		controller.abort(reason);
		await expect(
			withConsumerSpan(
				'consume x',
				undefined,
				async () => {
					throw reason;
				},
				{},
				controller.signal,
			),
		).rejects.toBe(reason);
		const [span] = recorder.spans();
		expect(span?.attributes['akashic.cancelled']).toBe(true);
		expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
	});

	test("a handler's error records its code, not its message", async () => {
		const failure = Object.assign(new Error('secret@example.test'), { code: 'ECONNRESET' });
		await expect(
			withConsumerSpan('consume x', undefined, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		const [span] = recorder.spans();
		expect(exported(span)).not.toContain('secret@example.test');
		expect(span?.attributes['error.type']).toBe('ECONNRESET');
	});
});

describe('propagation', () => {
	test("a consumer span continues the producer's trace", async () => {
		const parent = await traced('publish', {}, async () => currentTraceparent());
		await withConsumerSpan('consume realm.member_changed', parent, async () => undefined);
		const [producer, consumer] = recorder.spans();
		expect(consumer?.spanContext().traceId).toBe(producer?.spanContext().traceId);
	});
});
