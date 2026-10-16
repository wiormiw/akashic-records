import { afterAll, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { OutboxStatus, createDb, outboxMessages, publish } from '@akashic/db';
import { silentLogger } from '@akashic/lib/log';
import { markPublished, recordFailure } from '../src/event.ts';
import { createOutboxStore } from '../src/store.ts';

// The outbox store on the real database, where concurrent claims need real connections, so these
// rows commit. They are dated 1970 and every claim is made at a 1970 instant: a claim takes only
// rows due by then, so it can never pick up a real event (those are due in 2026). The oldest-first
// dead listing and revive are safe for the same reason: the 1970 rows sort before any real one.
// Rows are found and deleted by their own message type only. Skips when nothing answers at DATABASE_URL.

const database = createDb({
	url: Bun.env.DATABASE_URL ?? 'postgres://akashic:akashic@localhost:5432/akashic',
	poolMax: 3,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();

const TYPE = 'test.outbox_store';
const epoch = Temporal.Instant.from('1970-01-01T00:00:00Z');
const due = epoch.add({ minutes: 1 });
const lease = (seconds: number) => due.add({ seconds });

const store = createOutboxStore(database.db);
const remove = () => database.db.delete(outboxMessages).where(eq(outboxMessages.messageType, TYPE));

afterAll(async () => {
	if (live) await remove();
	await database[Symbol.asyncDispose]();
});

async function seed(count: number) {
	await remove();
	await database.db.transaction((tx) =>
		publish(
			tx,
			Array.from({ length: count }, (_, i) => ({ type: TYPE, payload: { i } })),
			epoch,
		),
	);
}

const rowsOf = (ids: string[]) =>
	database.db.select().from(outboxMessages).where(inArray(outboxMessages.id, ids));

describe.skipIf(!live)('outbox store', () => {
	test('two workers claiming at once never share an event', async () => {
		await seed(6);
		const [a, b] = await Promise.all([
			store.claim(due, lease(30), 4),
			store.claim(due, lease(31), 4),
		]);
		const ids = [...a, ...b].map((event) => event.id);
		expect(ids).toHaveLength(6);
		expect(new Set(ids).size).toBe(6);
		// Leased: nothing is due again until the lease runs out.
		expect(await store.claim(due, lease(60), 10)).toEqual([]);
	});

	test('the claim that holds the lease writes the outcome; a stale one changes nothing', async () => {
		await seed(1);
		const [claimed] = await store.claim(due, lease(30), 1);
		expect(claimed).toBeDefined();

		const failed = recordFailure(claimed!, lease(90), 'too slow', false);
		expect(await store.finish(failed, lease(29))).toBe(false);

		const published = markPublished(claimed!, lease(5));
		expect(await store.finish(published, claimed!.nextAttemptAt)).toBe(true);
		const [row] = await rowsOf([claimed!.id]);
		expect(row).toMatchObject({ status: OutboxStatus.published, attemptCount: 0, lastError: null });

		// Already finished: the lease no longer holds, so a late writer can't undo it.
		expect(await store.finish(failed, claimed!.nextAttemptAt)).toBe(false);
	});

	test('a failed event is claimable again once its retry is due, and dead is never', async () => {
		await seed(1);
		const [claimed] = await store.claim(due, lease(30), 1);
		await store.finish(recordFailure(claimed!, lease(2), 'flaky', false), claimed!.nextAttemptAt);
		expect(await store.claim(lease(1), lease(31), 1)).toEqual([]);

		const [again] = await store.claim(lease(2), lease(32), 1);
		expect(again).toMatchObject({ id: claimed!.id, attemptCount: 1, lastError: 'flaky' });
		await store.finish(recordFailure(again!, lease(4), 'flaky', true), again!.nextAttemptAt);
		expect(await store.claim(lease(3600), lease(3630), 1)).toEqual([]);
	});

	test('dead events are listed oldest first, and revive into the claimable queue', async () => {
		await seed(2);
		const claimed = await store.claim(due, lease(30), 2);
		for (const event of claimed) {
			await store.finish(recordFailure(event, lease(40), 'gone', true), event.nextAttemptAt);
		}
		// A dead event is never claimed, however late it gets.
		expect(await store.claim(lease(3600), lease(3630), 2)).toEqual([]);

		const dead = await store.dead(2);
		expect(dead.map((event) => event.id).sort()).toEqual(claimed.map((event) => event.id).sort());
		expect(dead.every((event) => event.status === OutboxStatus.dead)).toBe(true);

		const revived = await store.reviveDead(lease(3700), 2);
		expect(revived).toHaveLength(2);
		expect(revived[0]).toMatchObject({
			status: OutboxStatus.pending,
			attemptCount: 0,
			lastError: 'gone',
		});
		expect(await store.claim(lease(3700), lease(3730), 2)).toHaveLength(2);
	});
	test('prune deletes only published rows past the cutoff', async () => {
		await seed(3);
		const now = epoch.add({ hours: 24 * 60 });
		const [old, recent, dead] = await store.claim(due, lease(30), 3);
		const stamp = (event: typeof old, at: Temporal.Instant) =>
			store.finish(markPublished(event!, at), event!.nextAttemptAt);
		await stamp(old, now.subtract({ hours: 24 * 30 }));
		await stamp(recent, now.subtract({ hours: 24 }));
		await store.finish(recordFailure(dead!, lease(40), 'gone', true), dead!.nextAttemptAt);
		// Back-dated far enough to be due for deletion, were it published.
		await database.db
			.update(outboxMessages)
			.set({ createdAt: new Date(now.subtract({ hours: 24 * 30 }).epochMilliseconds) })
			.where(eq(outboxMessages.id, dead!.id));

		const cutoff = now.subtract({ hours: 24 * 7 });
		expect(await store.prune(cutoff, 100)).toBe(1);
		const left = await rowsOf([old!.id, recent!.id, dead!.id]);
		expect(left.map((row) => row.id).sort()).toEqual([recent!.id, dead!.id].sort());
		// Nothing more is due, so a second pass finds nothing.
		expect(await store.prune(cutoff, 100)).toBe(0);
	});

	test('one prune call is bounded by its limit', async () => {
		await seed(3);
		const claimed = await store.claim(due, lease(30), 3);
		for (const event of claimed) {
			await store.finish(markPublished(event, epoch.add({ minutes: 5 })), event.nextAttemptAt);
		}
		expect(await store.prune(epoch.add({ hours: 1 }), 2)).toBe(2);
		expect(await store.prune(epoch.add({ hours: 1 }), 2)).toBe(1);
	});
});
