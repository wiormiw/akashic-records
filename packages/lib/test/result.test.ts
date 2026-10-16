import { describe, expect, test } from 'bun:test';
import { ErrorCode, fail } from '@akashic/lib/errors';
import { err, mapOk, ok } from '@akashic/lib/result';
import { expectErr, expectOk } from '@akashic/lib/testing';

describe('result', () => {
	test('mapOk transforms a success', () => {
		expect(expectOk(mapOk(ok(2), (n) => n * 3))).toBe(6);
	});

	test('mapOk passes a failure through untouched', () => {
		const failure = err(fail.conflict(ErrorCode.realm.alreadyMember, 'Already in.'));
		const mapped = mapOk(failure, () => 1);
		expect(mapped).toBe(failure);
		expectErr(mapped, 'realm.already_member');
	});
});
