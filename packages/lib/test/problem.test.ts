import { describe, expect, test } from 'bun:test';
import { DuplicateSlug, UnexpectedError } from '@akashic/lib/errors';
import { toProblem } from '@akashic/lib/problem';

describe('problem', () => {
	test('a kind decides the status, and the code is on the body', () => {
		const { status, body } = toProblem(new DuplicateSlug('Taken.'), 't1');
		expect(status).toBe(409);
		expect(body).toMatchObject({ code: 'realm.duplicate_slug', detail: 'Taken.', traceId: 't1' });
	});

	test('an internal error never shows its message', () => {
		const { status, body } = toProblem(new UnexpectedError('password=hunter2'), 't1');
		expect(status).toBe(500);
		expect(body.detail).not.toContain('hunter2');
	});
});
