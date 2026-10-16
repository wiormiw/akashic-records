import { afterAll, describe, expect, test } from 'bun:test';
import { createDb } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { InterestStatus } from '@akashic/lib/enums';
import { EventNotFound, RealmForbidden } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { isError } from '@akashic/lib/result';
import { expectErr, expectOk, expectType } from '@akashic/lib/testing';
import { databaseUrl } from '../../support/fixtures.ts';
import { world } from './fixtures.ts';

// The interest service on the real database, each test in a transaction that is rolled back.

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (run: (w: ReturnType<typeof world>) => Promise<void>) =>
	withRollback(database.db, (tx) => run(world(tx)));

describe.skipIf(!live)('interest', () => {
	test('a member puts a hand up, withdraws, and a second show re-opens the same one', () =>
		inWorld(async (w) => {
			const realm = await w.realm({ members: 1 });
			const { job } = await w.seed(realm.id, realm.admin);
			const member = realm.people[0]!;

			const { id } = expectOk(await w.interest.show(realm.id, job, member, 'Me!'));
			expect(expectOk(await w.interest.drop(realm.id, job, member))).toEqual({ withdrawn: true });
			expect(await w.interestOf(job.id, member)).toBe(InterestStatus.withdrawn);
			// Nothing left to withdraw.
			expect(expectOk(await w.interest.drop(realm.id, job, member))).toEqual({ withdrawn: false });

			const again = expectOk(await w.interest.show(realm.id, job, member, 'Still me.'));
			expect(again.id).toBe(id);
			expect(await w.interestOf(job.id, member)).toBe(InterestStatus.open);
		}));

	test('nobody shows interest in their own posting; an event takes none', () =>
		inWorld(async (w) => {
			const realm = await w.realm();
			const { listing } = await w.seed(realm.id, realm.admin);
			const event = await w.event(realm.id, realm.admin);
			expectErr(
				await w.interest.show(realm.id, listing, realm.admin, undefined),
				'realm.forbidden',
			);
			expectErr(await w.interest.show(realm.id, event, realm.admin, undefined), 'event.not_found');
		}));

	test('a refused show narrows to the one error, leaving the rest', () =>
		inWorld(async (w) => {
			const realm = await w.realm();
			const { listing } = await w.seed(realm.id, realm.admin);
			const event = await w.event(realm.id, realm.admin);

			const own = await w.interest.show(realm.id, listing, realm.admin, undefined);
			if (!isError(own, RealmForbidden)) throw new Error('expected RealmForbidden');
			expect(expectType<RealmForbidden>(own.error)).toBeInstanceOf(RealmForbidden);
			// @ts-expect-error the branch holds only RealmForbidden
			expectType<EventNotFound>(own.error);

			const none = await w.interest.show(realm.id, event, realm.admin, undefined);
			if (isError(none, RealmForbidden)) throw new Error('expected EventNotFound');
			if (none.ok) throw new Error('expected an error');
			// RealmForbidden is ruled out, so EventNotFound is all that remains.
			expect(expectType<EventNotFound>(none.error)).toBeInstanceOf(EventNotFound);
			// @ts-expect-error RealmForbidden was narrowed away
			expectType<RealmForbidden>(none.error);
		}));

	test('the owner and a moderator see who is interested, oldest first; others may not', () =>
		inWorld(async (w) => {
			const realm = await w.realm({ members: 2 });
			const { job } = await w.seed(realm.id, realm.admin);
			const [first, second] = realm.people as [string, string];
			expectOk(await w.interest.show(realm.id, job, first, 'Me!'));
			expectOk(await w.interest.show(realm.id, job, second, undefined));
			expectOk(await w.interest.drop(realm.id, job, second));

			const seen = expectOk(await w.interest.list(realm.id, job, realm.admin, false));
			expect(seen).toMatchObject([
				{ userId: first, userName: 'Member 0', note: 'Me!', status: InterestStatus.open },
			]);
			expectOk(await w.interest.list(realm.id, job, second, true));
			expectErr(await w.interest.list(realm.id, job, second, false), 'realm.forbidden');
		}));

	test('a posting of another realm is not found to show, drop or list interest in', () =>
		inWorld(async (w) => {
			const realm = await w.realm({ members: 1 });
			const elsewhere = await w.realm({ members: 1 });
			const { job, listing } = await w.seed(elsewhere.id, elsewhere.admin);
			const theirs = elsewhere.people[0]!;
			expectOk(await w.interest.show(elsewhere.id, job, theirs, undefined));
			const member = realm.people[0]!;

			for (const subject of [job, listing]) {
				expectErr(await w.interest.show(realm.id, subject, member, undefined), 'event.not_found');
				expectErr(await w.interest.list(realm.id, subject, realm.admin, true), 'event.not_found');
			}
			// Even their own hand can't be withdrawn through another realm's URL.
			expectErr(await w.interest.drop(realm.id, job, theirs), 'event.not_found');
			expect(await w.interestOf(job.id, theirs)).toBe(InterestStatus.open);
			expect(await w.interestOf(job.id, member)).toBeUndefined();
		}));
});
