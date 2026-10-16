import { afterAll, describe, expect, test } from 'bun:test';
import { comments, createDb, type Tx } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { eq } from 'drizzle-orm';
import { AuditAction } from '@akashic/lib/enums';
import { EventNotFound, RealmForbidden } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { isError } from '@akashic/lib/result';
import { expectErr, expectOk } from '@akashic/lib/testing';
import { fixedClock, toDate } from '@akashic/lib/time';
import { createCommentService } from '@/modules/comments/comments.service.ts';
import { clock, databaseUrl } from '../../support/fixtures.ts';

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());
import { world } from './fixtures.ts';

// Compiles only when `value` is a T: the type assertions below lean on it.
const expectType = <T>(value: T): T => value;

// The comments service on the real database, each test in a transaction that is rolled back.

const inWorld = (run: (w: ReturnType<typeof world>, tx: Tx) => Promise<void>) =>
	withRollback(database.db, (tx) => run(world(tx), tx));

describe.skipIf(!live)('adding a comment', () => {
	test('stores it under an event, listing or job and publishes realm.posting_created', () =>
		inWorld(async (w) => {
			const { id: realmId, admin, people } = await w.realm(1);
			const subjects = await w.postings(realmId, admin);
			for (const subject of [subjects.event, subjects.listing, subjects.job]) {
				const { id } = expectOk(await w.service.add(realmId, subject, people[0]!, 'Count me in.'));
				expect(await w.row(id)).toMatchObject({
					realmId,
					subjectKind: subject.kind,
					subjectId: subject.id,
					authorId: people[0],
					body: 'Count me in.',
					removedAt: null,
				});
			}
			const published = await w.outbox('realm.posting_created', realmId);
			expect(published.length).toBe(3);
			expect(published[0]!.payload).toMatchObject({ kind: 'comment', authorId: people[0] });
		}));

	test('a posting of another realm is not found, and nothing is written', () =>
		inWorld(async (w, tx) => {
			const home = await w.realm(1);
			const elsewhere = await w.realm();
			const foreign = await w.postings(elsewhere.id, elsewhere.admin);
			for (const subject of [foreign.event, foreign.listing, foreign.job]) {
				expectErr(
					await w.service.add(home.id, subject, home.people[0]!, 'Hello?'),
					'event.not_found',
				);
			}
			expect(await tx.select().from(comments).where(eq(comments.realmId, home.id))).toEqual([]);
			expect((await w.outbox('realm.posting_created', home.id)).length).toBe(0);
		}));

	test("a posting that doesn't exist is not found", () =>
		inWorld(async (w) => {
			const { id: realmId, people } = await w.realm(1);
			expectErr(
				await w.service.add(realmId, { kind: 0, id: Bun.randomUUIDv7() }, people[0]!, 'Hi'),
				'event.not_found',
			);
		}));

	test('a thread with comments turned off is forbidden', () =>
		inWorld(async (w) => {
			const { id: realmId, admin, people } = await w.realm(1);
			const { event } = await w.postings(realmId, admin, false);
			expectErr(await w.service.add(realmId, event, people[0]!, 'Hi'), 'realm.forbidden');
			expect(await w.rows(event.id)).toEqual([]);
		}));

	test('a refused comment narrows to the one error, leaving the rest', () =>
		inWorld(async (w) => {
			const { id: realmId, admin, people } = await w.realm(1);
			const { event } = await w.postings(realmId, admin, false);
			const closed = await w.service.add(realmId, event, people[0]!, 'Hi');
			if (!isError(closed, RealmForbidden)) throw new Error('expected RealmForbidden');
			expect(expectType<RealmForbidden>(closed.error)).toBeInstanceOf(RealmForbidden);
			// @ts-expect-error the branch holds only RealmForbidden
			expectType<EventNotFound>(closed.error);

			const nowhere = { kind: event.kind, id: Bun.randomUUIDv7() };
			const missing = await w.service.add(realmId, nowhere, people[0]!, 'Hi');
			if (isError(missing, RealmForbidden)) throw new Error('expected EventNotFound');
			if (missing.ok) throw new Error('expected an error');
			// RealmForbidden is ruled out, so EventNotFound is all that remains.
			expect(expectType<EventNotFound>(missing.error)).toBeInstanceOf(EventNotFound);
			// @ts-expect-error RealmForbidden was narrowed away
			expectType<RealmForbidden>(missing.error);
		}));
});

describe.skipIf(!live)('reading a thread', () => {
	test("lists oldest first with the author's name, a removed comment keeping its place", () =>
		inWorld(async (w, tx) => {
			const { id: realmId, admin, people } = await w.realm(1);
			const { event } = await w.postings(realmId, admin);
			const first = expectOk(await w.service.add(realmId, event, people[0]!, 'First'));
			const second = expectOk(await w.service.add(realmId, event, admin, 'Second'));
			// A transaction's now() is fixed, so give the two comments distinct times.
			await tx
				.update(comments)
				.set({ createdAt: new Date('2026-01-02T00:00:00Z') })
				.where(eq(comments.id, second.id));
			await tx
				.update(comments)
				.set({ createdAt: new Date('2026-01-01T00:00:00Z') })
				.where(eq(comments.id, first.id));
			expectOk(await w.service.remove(realmId, first.id, admin));

			const thread = expectOk(await w.service.thread(realmId, event));
			expect(thread.map((c) => [c.body, c.removed, c.authorName])).toEqual([
				['', true, 'Member 0'],
				['Second', false, 'Founder'],
			]);
		}));

	test('a posting of another realm is not found, so its thread stays private', () =>
		inWorld(async (w) => {
			const home = await w.realm();
			const elsewhere = await w.realm(1);
			const { event } = await w.postings(elsewhere.id, elsewhere.admin);
			expectOk(await w.service.add(elsewhere.id, event, elsewhere.people[0]!, 'Secret'));
			expectErr(await w.service.thread(home.id, event), 'event.not_found');
		}));
});

describe.skipIf(!live)('removing a comment', () => {
	test('soft-deletes it, once and only once found', () =>
		inWorld(async (w) => {
			const { id: realmId, admin, people } = await w.realm(1);
			const { event } = await w.postings(realmId, admin);
			const { id } = expectOk(await w.service.add(realmId, event, people[0]!, 'Oops'));

			expect(expectOk(await w.service.remove(realmId, id, people[0]!))).toEqual({ removed: true });
			// Stamped by the injected clock.
			expect((await w.row(id))?.removedAt).toEqual(toDate(clock.now()));
			// The author removing their own leaves no record.
			expect(await w.audits(id)).toEqual([]);
			expectErr(await w.service.remove(realmId, Bun.randomUUIDv7(), admin), 'event.not_found');
		}));

	test("someone else's removal is recorded as a moderator's", () =>
		inWorld(async (w) => {
			const { id: realmId, admin, people } = await w.realm(1);
			const { event } = await w.postings(realmId, admin);
			const { id } = expectOk(await w.service.add(realmId, event, people[0]!, 'Rude'));

			expectOk(await w.service.remove(realmId, id, admin));
			expect(await w.audits(id)).toEqual([
				expect.objectContaining({
					userId: admin,
					entityType: 'comment',
					action: AuditAction.deleted,
					changes: { by: 'moderator' },
				}),
			]);
		}));

	test('removing it again changes nothing: same answer, first time kept, one record', () =>
		inWorld(async (w, tx) => {
			const { id: realmId, admin, people } = await w.realm(1);
			const { event } = await w.postings(realmId, admin);
			const { id } = expectOk(await w.service.add(realmId, event, people[0]!, 'Rude'));

			expectOk(await w.service.remove(realmId, id, admin));
			const first = (await w.row(id))?.removedAt;
			// An hour later, by another moderator's hand.
			const later = createCommentService({ db: tx, clock: fixedClock('2026-06-01T13:00:00Z') });
			const other = await w.person('Moderator');
			expect(expectOk(await later.remove(realmId, id, other))).toEqual({ removed: true });
			expect((await w.row(id))?.removedAt).toEqual(first!);
			expect(await w.audits(id)).toHaveLength(1);
		}));

	test('a comment of another realm is not found and stays', () =>
		inWorld(async (w) => {
			const home = await w.realm();
			const elsewhere = await w.realm(1);
			const { event } = await w.postings(elsewhere.id, elsewhere.admin);
			const { id } = expectOk(
				await w.service.add(elsewhere.id, event, elsewhere.people[0]!, 'Mine'),
			);

			expectErr(await w.service.remove(home.id, id, home.admin), 'event.not_found');
			expect((await w.row(id))?.removedAt).toBeNull();
		}));
});
