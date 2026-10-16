import { afterAll, describe, expect, test } from 'bun:test';
import { createDb, type Tx } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { AuditAction, RealmModule, RealmRole, TakedownStatus } from '@akashic/lib/enums';
import { ErrorCode } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { expectErr, expectOk } from '@akashic/lib/testing';
import { actsAlone } from '@/modules/governance/governance.takedowns.service.ts';
import { databaseUrl } from '../../support/fixtures.ts';
import { world, type World } from './fixtures.ts';

describe('acting alone', () => {
	test('fewer than three moderators have no quorum to wait for', () => {
		expect(actsAlone(1)).toBe(true);
		expect(actsAlone(2)).toBe(true);
		expect(actsAlone(3)).toBe(false);
	});
});

// The takedowns service on the real database, each test in a transaction that is rolled back.

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

const REASON = 'Breaks the rules.';

/**
 * A realm with five moderators (the founder and four), so takedowns wait for a vote: a majority
 * is three. Takedowns work in every realm, so it runs no modules.
 */
async function moderated(w: World) {
	const realm = await w.realm(5, []);
	const [author, ...moderators] = realm.people as [string, ...string[]];
	for (const moderator of moderators) await w.setRole(realm.id, moderator, RealmRole.moderator);
	const commentId = await w.comment(realm.id, author);
	return { ...realm, author, moderators: [realm.admin, ...moderators], commentId };
}

describe.skipIf(!live)('proposing a takedown', () => {
	test("a lone moderator's takedown removes the comment at once", () =>
		inWorld(async (w) => {
			const { id, admin, people } = await w.realm(1, [RealmModule.events]);
			const commentId = await w.comment(id, people[0]!);

			const outcome = expectOk(await w.takedowns.proposeTakedown(id, commentId, REASON, admin));
			expect(outcome).toMatchObject({ carried: true, agrees: 1, needed: 1 });
			expect((await w.commentRow(commentId))?.removedAt).not.toBeNull();
			const [takedown] = await w.takedownRows(id);
			expect(takedown).toMatchObject({ status: TakedownStatus.carried, subjectId: commentId });
			expect(await w.audits(commentId)).toEqual([
				expect.objectContaining({
					userId: admin,
					action: AuditAction.moderated,
					changes: { realmId: id, reason: REASON, removed: true, sole: true },
				}),
			]);
		}));

	test('with a quorum it opens a vote, listed with the majority it needs', () =>
		inWorld(async (w) => {
			const { id, moderators, commentId } = await moderated(w);
			const opened = expectOk(
				await w.takedowns.proposeTakedown(id, commentId, REASON, moderators[0]!),
			);
			expect(opened).toMatchObject({ carried: false, agrees: 1, needed: 3 });
			expect((await w.commentRow(commentId))?.removedAt).toBeNull();

			// The list and the tally use the same figure.
			expect(await w.takedowns.openTakedowns(id, 50)).toEqual([
				expect.objectContaining({
					id: opened.id,
					realmId: id,
					subjectId: commentId,
					reason: REASON,
					proposedBy: { id: moderators[0], name: 'Founder' },
					status: TakedownStatus.open,
					agrees: 1,
					refusals: 0,
					needed: 3,
				}),
			]);
			expectErr(
				await w.takedowns.proposeTakedown(id, commentId, REASON, moderators[1]!),
				ErrorCode.realm.alreadyMember,
			);
		}));

	test('a comment from another realm is not found, and nothing changes', () =>
		inWorld(async (w) => {
			const home = await w.realm(0, []);
			const elsewhere = await moderated(w);

			expectErr(
				await w.takedowns.proposeTakedown(home.id, elsewhere.commentId, REASON, home.admin),
				ErrorCode.realm.notFound,
			);
			expect((await w.commentRow(elsewhere.commentId))?.removedAt).toBeNull();
			expect(await w.takedownRows(home.id)).toEqual([]);
			expect(await w.audits(elsewhere.commentId)).toEqual([]);
		}));
});

describe.skipIf(!live)('voting on a takedown', () => {
	test('the vote that reaches a majority carries it and removes the comment', () =>
		inWorld(async (w) => {
			const { id, moderators, commentId } = await moderated(w);
			const { id: takedownId } = expectOk(
				await w.takedowns.proposeTakedown(id, commentId, REASON, moderators[0]!),
			);
			expect(
				expectOk(await w.takedowns.voteOnTakedown(id, takedownId, moderators[1]!, true)),
			).toEqual({ status: TakedownStatus.open, agrees: 2, refusals: 0, needed: 3 });
			expect(
				expectOk(await w.takedowns.voteOnTakedown(id, takedownId, moderators[2]!, true)),
			).toEqual({ status: TakedownStatus.carried, agrees: 3, refusals: 0, needed: 3 });

			expect((await w.commentRow(commentId))?.removedAt).not.toBeNull();
			expect(await w.audits(commentId)).toEqual([
				expect.objectContaining({
					userId: moderators[2],
					changes: { realmId: id, reason: REASON, removed: true, agrees: 3 },
				}),
			]);
			expectErr(
				await w.takedowns.voteOnTakedown(id, takedownId, moderators[3]!, true),
				ErrorCode.realm.alreadyMember,
			);
		}));

	test('once refusals leave too few to carry it, it is refused and the comment stays', () =>
		inWorld(async (w) => {
			const { id, moderators, commentId } = await moderated(w);
			const { id: takedownId } = expectOk(
				await w.takedowns.proposeTakedown(id, commentId, REASON, moderators[0]!),
			);
			await w.takedowns.voteOnTakedown(id, takedownId, moderators[1]!, false);
			await w.takedowns.voteOnTakedown(id, takedownId, moderators[2]!, false);
			expect(
				expectOk(await w.takedowns.voteOnTakedown(id, takedownId, moderators[3]!, false)),
			).toEqual({ status: TakedownStatus.refused, agrees: 1, refusals: 3, needed: 3 });
			expect((await w.commentRow(commentId))?.removedAt).toBeNull();
			expect(await w.takedowns.openTakedowns(id, 50)).toEqual([]);
		}));

	test("another realm's takedown is not found, and the vote is not counted", () =>
		inWorld(async (w) => {
			const home = await moderated(w);
			const elsewhere = await w.realm(0, []);
			const { id: takedownId } = expectOk(
				await w.takedowns.proposeTakedown(home.id, home.commentId, REASON, home.moderators[0]!),
			);
			expectErr(
				await w.takedowns.voteOnTakedown(elsewhere.id, takedownId, elsewhere.admin, true),
				ErrorCode.realm.notFound,
			);
			expect((await w.takedowns.openTakedowns(home.id, 50))[0]).toMatchObject({ agrees: 1 });
		}));
});
