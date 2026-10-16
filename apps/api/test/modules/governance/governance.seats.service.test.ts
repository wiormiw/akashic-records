import { afterAll, describe, expect, test } from 'bun:test';
import { createDb, type Tx } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { AuditAction, RealmRole } from '@akashic/lib/enums';
import { ErrorCode, NoSeatInRealm, ValidationFailed } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { isError } from '@akashic/lib/result';
import { expectErr, expectOk, expectType } from '@akashic/lib/testing';
import {
	cannotCarry,
	majority,
	MIN_UPVOTES,
	seats,
	sizeFrom,
} from '@/modules/governance/governance.seats.service.ts';
import { databaseUrl } from '../../support/fixtures.ts';
import { world, type World } from './fixtures.ts';

describe('seats', () => {
	test('at least one, so a realm can always elect somebody', () => {
		expect(seats(0)).toBe(1);
		expect(seats(1)).toBe(1);
	});

	test('one per twenty-five members, never more than ten', () => {
		expect(seats(26)).toBe(2);
		expect(seats(100)).toBe(4);
		expect(seats(10_000)).toBe(10);
	});
});

describe('vote thresholds', () => {
	test('a simple majority', () => {
		expect(majority(1)).toBe(1);
		expect(majority(4)).toBe(3);
		expect(majority(5)).toBe(3);
	});

	test('a vote is lost once too few voters remain to carry it', () => {
		expect(cannotCarry(2, 5, 3)).toBe(false);
		expect(cannotCarry(3, 5, 3)).toBe(true);
	});
});

describe('realm size', () => {
	test('counts arrive as strings and a missing row is an empty realm', () => {
		expect(sizeFrom({ members: '12', moderators: '2' })).toEqual({ members: 12, moderators: 2 });
		expect(sizeFrom(undefined)).toEqual({ members: 0, moderators: 0 });
	});
});

// The seats service on the real database, each test in a transaction that is rolled back.

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (run: (w: World, tx: Tx) => Promise<void>) =>
	withRollback(database.db, (tx) => run(world(tx), tx));

describe.skipIf(!live)('upvoting', () => {
	test('the third upvote seats a candidate, announced and recorded with no actor', () =>
		inWorld(async (w) => {
			const { id, people } = await w.realm(4);
			const [candidate, ...voters] = people as [string, ...string[]];

			expect(expectOk(await w.seats.upvote(id, voters[0]!, candidate))).toEqual({
				upvotes: 1,
				seats: 1,
				seated: [],
				unseated: [],
			});
			expect(expectOk(await w.seats.upvote(id, voters[1]!, candidate)).seated).toEqual([]);
			// A repeated upvote counts once.
			expect(expectOk(await w.seats.upvote(id, voters[1]!, candidate)).upvotes).toBe(2);

			const third = expectOk(await w.seats.upvote(id, voters[2]!, candidate));
			expect(third).toMatchObject({ upvotes: MIN_UPVOTES, seated: [candidate], unseated: [] });
			expect(await w.roleOf(id, candidate)).toBe(RealmRole.moderator);
			expect(await w.memberChanges(id)).toEqual([
				{ realmId: id, userId: candidate, role: RealmRole.moderator },
			]);
			const [entry] = await w.audits(candidate);
			expect(entry).toMatchObject({
				userId: null,
				action: AuditAction.roleChanged,
				changes: { realmId: id, role: RealmRole.moderator, by: 'election' },
			});
		}));

	test('the one seat goes to the most upvoted, ties to the longest member', () =>
		inWorld(async (w) => {
			const { id, people } = await w.realm(6);
			const [senior, junior, ...voters] = people as [string, string, ...string[]];
			for (const voter of voters.slice(0, 3)) expectOk(await w.seats.upvote(id, voter, junior));
			expect(await w.roleOf(id, junior)).toBe(RealmRole.moderator);
			await w.upvotes(id, senior, voters.slice(0, 2));

			// Senior draws level with junior: seniority wins and the seat changes hands.
			expect(expectOk(await w.seats.upvote(id, voters[3]!, senior))).toMatchObject({
				seated: [senior],
				unseated: [junior],
			});
			expect(await w.roleOf(id, junior)).toBe(RealmRole.member);
			expect((await w.memberChanges(id)).slice(1)).toEqual([
				{ realmId: id, userId: senior, role: RealmRole.moderator },
				{ realmId: id, userId: junior, role: RealmRole.member },
			]);

			const standings = await w.seats.standings(id, 50);
			expect(standings).toMatchObject({ seats: 1, minimum: MIN_UPVOTES });
			expect(standings.members.slice(0, 2).map((m) => [m.userId, m.upvotes, m.seated])).toEqual([
				[senior, 3, true],
				[junior, 3, false],
			]);
		}));

	test('withdrawing the upvote that held a seat gives the seat up', () =>
		inWorld(async (w) => {
			const { id, people } = await w.realm(4);
			const [candidate, ...voters] = people as [string, ...string[]];
			for (const voter of voters) expectOk(await w.seats.upvote(id, voter, candidate));
			expect(await w.roleOf(id, candidate)).toBe(RealmRole.moderator);

			expect(expectOk(await w.seats.withdrawUpvote(id, voters[0]!, candidate))).toEqual({
				upvotes: 2,
				seated: [],
				unseated: [candidate],
			});
			expect(await w.roleOf(id, candidate)).toBe(RealmRole.member);
			expect(await w.memberChanges(id)).toEqual([
				{ realmId: id, userId: candidate, role: RealmRole.moderator },
				{ realmId: id, userId: candidate, role: RealmRole.member },
			]);
		}));

	test('yourself, a non-member and an admin are refused, and nothing is written', () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm(1);
			const [member] = people as [string];
			const stranger = await w.person();

			expectErr(await w.seats.upvote(id, member, member), ErrorCode.common.validation);
			expectErr(await w.seats.upvote(id, member, stranger), ErrorCode.realm.notMember);
			expectErr(await w.seats.upvote(id, member, admin), ErrorCode.common.validation);
			expect(await w.endorsementsOf(id, admin)).toEqual([]);
			expect(await w.endorsementsOf(id, stranger)).toEqual([]);
		}));
});

describe.skipIf(!live)('a refused upvote', () => {
	test('narrows to the one error, leaving the rest', () =>
		inWorld(async (w) => {
			const { id, people } = await w.realm(1);
			const [member] = people as [string];
			const stranger = await w.person();

			const nobody = await w.seats.upvote(id, member, stranger);
			if (!isError(nobody, NoSeatInRealm)) throw new Error('expected NoSeatInRealm');
			expect(expectType<NoSeatInRealm>(nobody.error)).toBeInstanceOf(NoSeatInRealm);
			// @ts-expect-error the branch holds only NoSeatInRealm
			expectType<ValidationFailed>(nobody.error);

			const self = await w.seats.upvote(id, member, member);
			if (isError(self, NoSeatInRealm)) throw new Error('expected ValidationFailed');
			if (self.ok) throw new Error('expected an error');
			// NoSeatInRealm is ruled out, so ValidationFailed is all that remains.
			expect(expectType<ValidationFailed>(self.error)).toBeInstanceOf(ValidationFailed);
			// @ts-expect-error NoSeatInRealm was narrowed away
			expectType<NoSeatInRealm>(self.error);
		}));
});

describe.skipIf(!live)('removing a moderator', () => {
	test('takes the seat and its upvotes, announced, and refills from the standings', () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm(5);
			const [moderator, next, ...voters] = people as [string, string, ...string[]];
			await w.upvotes(id, moderator, voters);
			await w.upvotes(id, next, voters);
			await w.setRole(id, moderator, RealmRole.moderator);

			expect(
				expectOk(await w.seats.removeModerator(id, moderator, admin, 'Gone quiet for months.')),
			).toEqual({ removed: true });
			expect(await w.roleOf(id, moderator)).toBe(RealmRole.member);
			expect(await w.endorsementsOf(id, moderator)).toEqual([]);
			expect(await w.roleOf(id, next)).toBe(RealmRole.moderator);
			expect(await w.memberChanges(id)).toEqual([
				{ realmId: id, userId: moderator, role: RealmRole.member },
				{ realmId: id, userId: next, role: RealmRole.moderator },
			]);
			const [entry] = await w.audits(moderator);
			expect(entry).toMatchObject({
				userId: admin,
				changes: {
					realmId: id,
					role: RealmRole.member,
					by: 'admin',
					reason: 'Gone quiet for months.',
				},
			});
		}));

	test('an admin or a member holds no seat to take', () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm(1);
			const other = await w.person();
			expectErr(
				await w.seats.removeModerator(id, admin, other, 'Not an elected seat.'),
				ErrorCode.common.validation,
			);
			expectErr(
				await w.seats.removeModerator(id, people[0]!, admin, 'Holds no seat at all.'),
				ErrorCode.realm.notMember,
			);
			expect(await w.memberChanges(id)).toEqual([]);
		}));
});
