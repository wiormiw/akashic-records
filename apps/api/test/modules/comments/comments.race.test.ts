import { afterAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import {
	comments,
	createDb,
	events,
	outboxMessages,
	realmMembers,
	realms,
	user,
} from '@akashic/db';
import { CommentSubject, RealmRole } from '@akashic/lib/enums';
import { silentLogger } from '@akashic/lib/log';
import { expectErr } from '@akashic/lib/testing';
import { createCommentService } from '@/modules/comments/comments.service.ts';
import { clock, databaseUrl, uniqueSlug } from '../../support/fixtures.ts';

// Turning comments off while a comment is being added needs two connections, so this can't run
// inside one rolled-back transaction: it commits its own uniquely named rows and deletes exactly
// those afterwards.

const database = createDb({
	url: databaseUrl,
	poolMax: 4,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)('a comment while comments are being turned off', () => {
	test('the add waits for the switch-off, then is refused', async () => {
		const { db } = database;
		const author = Bun.randomUUIDv7();
		const slug = uniqueSlug('comment-race');
		let realmId: string | undefined;
		try {
			await db.insert(user).values({
				id: author,
				name: 'Commenter',
				email: `comment-race-${Bun.randomUUIDv7()}@example.test`,
			});
			const [realm] = await db
				.insert(realms)
				.values({ slug, name: 'Comment race', createdBy: author })
				.returning({ id: realms.id });
			realmId = realm!.id;
			await db.insert(realmMembers).values({ realmId, userId: author, role: RealmRole.member });
			const [event] = await db
				.insert(events)
				.values({
					realmId,
					authorId: author,
					title: 'Meetup',
					description: 'Come along.',
					startsAt: new Date('2030-01-01T00:00:00Z'),
					commentsEnabled: true,
				})
				.returning({ id: events.id });
			const subject = { kind: CommentSubject.event, id: event!.id };
			const service = createCommentService({ db, clock });

			let pending: ReturnType<typeof service.add> | undefined;
			await db.transaction(async (tx) => {
				const [row] = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as {
					pid: number;
				}[];
				await tx.update(events).set({ commentsEnabled: false }).where(eq(events.id, event!.id));
				pending = service.add(realmId!, subject, author, 'Too late?');
				// Hold the switch-off uncommitted until the add is queued behind it (or a second
				// passes, so a version that doesn't lock still finishes and fails on its outcome).
				for (let i = 0; i < 100; i++) {
					const [blocked] = (await db.execute(
						sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${row!.pid} = ANY(pg_blocking_pids(pid))`,
					)) as unknown as { n: number }[];
					if ((blocked?.n ?? 0) >= 1) break;
					await Bun.sleep(10);
				}
			});

			expectErr(await pending!, 'realm.forbidden');
			expect(await db.select().from(comments).where(eq(comments.subjectId, event!.id))).toEqual([]);
		} finally {
			if (realmId) {
				await db
					.delete(outboxMessages)
					.where(sql`${outboxMessages.payload}->>'realmId' = ${realmId}`);
				// Events, comments and members cascade from the realm.
				await db.delete(realms).where(eq(realms.id, realmId));
			}
			await db.delete(user).where(eq(user.id, author));
		}
	});
});
