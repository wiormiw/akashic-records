import { describe, expect, test } from 'bun:test';
import * as errors from '@akashic/lib/errors';
import {
	AppError,
	ErrorCode,
	EventNotFound,
	MemberNotFound,
	NoSeatInRealm,
	NotBothMembers,
	RealmNotFound,
	ServiceUnavailable,
	defineError,
} from '@akashic/lib/errors';
import { httpStatusByKind, toProblem } from '@akashic/lib/problem';
import { err, ok, type Result } from '@akashic/lib/result';
import { expectErr } from '@akashic/lib/testing';

/**
 * Every class, with the code and status it answers with today. Written out rather than derived,
 * so a class whose kind changes fails here instead of silently moving a status on the wire.
 * The statuses come from the `fail.<kind>(ErrorCode…)` pairs the code used on 2026-10-16.
 */
const catalogue: Record<string, readonly [code: string, status: number]> = {
	AccountSuspended: ['auth.account.suspended', 403],
	Unauthenticated: ['auth.session.unauthenticated', 401],
	SessionExpired: ['auth.session.expired', 401],
	Forbidden: ['common.auth.forbidden', 403],
	ContentTooLarge: ['common.request.payload_too_large', 400],
	RateLimited: ['common.request.rate_limited', 429],
	RouteNotFound: ['common.route.not_found', 404],
	RequestTimeout: ['common.request.timeout', 502],
	RequestCancelled: ['common.request.cancelled', 503],
	ServiceUnavailable: ['common.request.unavailable', 503],
	UnexpectedError: ['common.server.unexpected', 500],
	ValidationFailed: ['common.request.validation_failed', 400],
	PostingSettled: ['posting.already_settled', 409],
	EventFull: ['event.at_capacity', 409],
	EventNotFound: ['event.not_found', 404],
	EventInPast: ['event.already_happened', 400],
	AuthzUnavailable: ['external.authz.unavailable', 502],
	DeliveryFailed: ['external.resend.delivery_failed', 502],
	StorageNotConfigured: ['external.storage.not_configured', 502],
	AiUnavailable: ['external.ai.unavailable', 502],
	AiNotConfigured: ['external.ai.not_configured', 502],
	AlreadyMember: ['realm.already_member', 409],
	RealmArchived: ['realm.archived', 409],
	DuplicateSlug: ['realm.duplicate_slug', 409],
	RealmForbidden: ['realm.forbidden', 403],
	ModuleDisabled: ['realm.module_disabled', 404],
	RealmNotFound: ['realm.not_found', 404],
	// realm.not_member is answered with three statuses today, so it has a class per status.
	MemberNotFound: ['realm.not_member', 404],
	NoSeatInRealm: ['realm.not_member', 400],
	NotBothMembers: ['realm.not_member', 403],
	SoleAdmin: ['realm.sole_admin', 409],
};

type ErrorClass = (new () => AppError) & { kind: string; code: string };

const classes = (Object.entries(errors) as [string, unknown][]).filter(
	(entry): entry is [string, ErrorClass] =>
		typeof entry[1] === 'function' && entry[1].prototype instanceof AppError,
);

const leaves = (node: object): string[] =>
	Object.values(node).flatMap((v) => (typeof v === 'string' ? [v] : leaves(v as object)));

describe('error catalogue', () => {
	test('lists exactly the exported classes', () => {
		expect(classes.map(([name]) => name).toSorted()).toEqual(Object.keys(catalogue).toSorted());
	});

	test.each(Object.entries(catalogue))('%s keeps its code and status', (name, [code, status]) => {
		const Class = classes.find(([n]) => n === name)?.[1];
		if (!Class) throw new Error(`${name} is not exported`);
		const error = new Class();
		expect(error).toBeInstanceOf(AppError);
		expect(error.code).toBe(code);
		expect(httpStatusByKind[error.kind]).toBe(status);
		expect(Class.code).toBe(error.code);
		expect(Class.kind).toBe(error.kind);
		expect(error.message.length).toBeGreaterThan(0);
	});

	test('every stable code has a class', () => {
		const covered = new Set(Object.values(catalogue).map(([code]) => code));
		expect(leaves(ErrorCode).filter((code) => !covered.has(code))).toEqual([]);
	});
});

describe('defineError', () => {
	test('takes a message and options, falling back to the default message', () => {
		const cause = new Error('boom');
		const error = new RealmNotFound('No realm called "x".', { details: { slug: 'x' }, cause });
		expect(error.message).toBe('No realm called "x".');
		expect(error.details).toEqual({ slug: 'x' });
		expect(error.cause).toBe(cause);
		expect(new RealmNotFound().message).toBe('No such realm.');
	});

	test('carries kind and code as literal types', () => {
		const Gone = defineError('not_found', 'test.gone', 'Gone.');
		const kind: 'not_found' = new Gone().kind;
		const code: 'test.gone' = Gone.code;
		expect([kind, code]).toEqual(['not_found', 'test.gone']);
	});

	test('two codes are never assignable to each other', () => {
		// @ts-expect-error an event's absence is not a realm's
		const realm: RealmNotFound = new EventNotFound();
		// The three realm.not_member classes differ by kind, so they stay apart too.
		// @ts-expect-error a seat refusal is not a missing member
		const member: MemberNotFound = new NoSeatInRealm();
		// @ts-expect-error nor is a room refusal
		const seat: NoSeatInRealm = new NotBothMembers();
		expect([realm, member, seat]).toHaveLength(3);
	});

	test('unavailable is a 503 with its own title', () => {
		const { status, body } = toProblem(new ServiceUnavailable(), 't1');
		expect(status).toBe(503);
		expect(body).toMatchObject({
			code: 'common.request.unavailable',
			title: 'Service unavailable',
		});
	});
});

describe('expectErr', () => {
	const failing = (): Result<number, RealmNotFound | EventNotFound> =>
		err(new EventNotFound('No such event in this realm.'));

	test('takes a class and returns the error narrowed to it', () => {
		const error: EventNotFound = expectErr(failing(), EventNotFound);
		expect(error.message).toBe('No such event in this realm.');
	});

	test('takes a code and returns the error with that code', () => {
		const error: EventNotFound = expectErr(failing(), 'event.not_found');
		expect(error.code).toBe('event.not_found');
	});

	test('still takes any code for an untyped result', () => {
		const untyped: Result<number, AppError> = err(new RealmNotFound());
		expect(expectErr(untyped, ErrorCode.realm.notFound)).toBeInstanceOf(RealmNotFound);
	});

	test('refuses a class or code the result cannot hold', () => {
		if (Date.now() < 0) {
			// @ts-expect-error MemberNotFound is not one of the errors
			expectErr(failing(), MemberNotFound);
			// @ts-expect-error nor is its code
			expectErr(failing(), 'realm.not_member');
		}
	});

	test('fails the test on a success or another error', () => {
		const success = (): Result<number, RealmNotFound> => ok(1);
		expect(() => expectErr(success(), RealmNotFound)).toThrow();
		expect(() => expectErr(failing(), RealmNotFound)).toThrow();
		expect(() => expectErr(failing(), 'realm.not_found')).toThrow();
	});
});
