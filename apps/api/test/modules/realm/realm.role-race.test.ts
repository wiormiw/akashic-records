import { afterAll, describe, expect, test } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auditEntries, createDb, outboxMessages, realmMembers, realms, user } from '@akashic/db';
import { RealmRole } from '@akashic/lib/enums';
import { silentLogger } from '@akashic/lib/log';
import { realmApp } from './app.ts';
import { databaseUrl, uniqueSlug } from '../../support/fixtures.ts';

// Changes racing each other need several connections, so this can't run inside one rolled-back
// transaction: it commits its own uniquely named rows and deletes exactly those afterwards.
//
// A third connection holds the realm's member rows FOR UPDATE until both requests are queued
// behind it, so the two really do run at once rather than one after the other.

const database = createDb({
	url: databaseUrl,
	poolMax: 8,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

type Call = ReturnType<typeof realmApp>['call'];
type Answer = Awaited<ReturnType<Call>>;

/**
 * Runs `start` while a transaction holds the realm's member rows locked, and releases them only
 * once `waiters` sessions are blocked behind it (or after a second, so a version without the lock
 * still finishes and fails on its outcome).
 */
async function behindALock(
	realmId: string,
	waiters: number,
	start: () => Promise<Answer>[],
): Promise<Answer[]> {
	const { db } = database;
	let answers: Promise<Answer[]> | undefined;
	await db.transaction(async (tx) => {
		const [row] = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as {
			pid: number;
		}[];
		await tx
			.select({ userId: realmMembers.userId })
			.from(realmMembers)
			.where(eq(realmMembers.realmId, realmId))
			.for('update');
		answers = Promise.all(start());
		for (let i = 0; i < 100; i++) {
			const [blocked] = (await db.execute(
				sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${row!.pid} = ANY(pg_blocking_pids(pid))`,
			)) as unknown as { n: number }[];
			if ((blocked?.n ?? 0) >= waiters) break;
			await Bun.sleep(10);
		}
	});
	return answers!;
}

/** Two admins in a fresh realm, the one with the higher id inserted first. */
async function twoAdmins() {
	const { db } = database;
	const tag = Bun.randomUUIDv7();
	// UUIDv7s sort by creation: `low` < `high`.
	const [low, high] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
	const slug = uniqueSlug('role-race');
	await db.insert(user).values([
		{ id: high, name: 'High', email: `role-race-high-${tag}@example.test` },
		{ id: low, name: 'Low', email: `role-race-low-${tag}@example.test` },
	]);
	const [realm] = await db
		.insert(realms)
		.values({ slug, name: 'Role race', createdBy: low })
		.returning({ id: realms.id });
	const realmId = realm!.id;
	// High first, so a scan in physical order meets the rows against user id order.
	await db.insert(realmMembers).values({ realmId, userId: high, role: RealmRole.admin });
	await db.insert(realmMembers).values({ realmId, userId: low, role: RealmRole.admin });
	return { realmId, slug, low, high };
}

async function cleanUp(realmId: string, userIds: string[]) {
	const { db } = database;
	await db.delete(outboxMessages).where(sql`${outboxMessages.payload}->>'realmId' = ${realmId}`);
	// Members cascade from the realm.
	await db.delete(realms).where(eq(realms.id, realmId));
	await db.delete(auditEntries).where(inArray(auditEntries.userId, userIds));
	await db.delete(user).where(inArray(user.id, userIds));
}

const adminsOf = (realmId: string) =>
	database.db
		.select({ userId: realmMembers.userId })
		.from(realmMembers)
		.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.role, RealmRole.admin)));

describe.skipIf(!live)('role changes at the same moment', () => {
	test('two admins demoting each other: exactly one succeeds, so the realm keeps an admin', async () => {
		const { realmId, slug, low, high } = await twoAdmins();
		try {
			const { call, grants } = realmApp(database.db);
			grants.realm.set(low, new Set(['can_vouch']));
			grants.realm.set(high, new Set(['can_vouch']));
			const demote = (actor: string, target: string) =>
				call('PATCH', `/api/v1/realms/${slug}/members/${target}`, {
					as: actor,
					body: { role: RealmRole.member },
				});

			const answers = await behindALock(realmId, 2, () => [demote(low, high), demote(high, low)]);

			expect(answers.map((a) => a.status).sort()).toEqual([200, 403]);
			expect(await adminsOf(realmId)).toHaveLength(1);
		} finally {
			await cleanUp(realmId, [low, high]);
		}
	});

	test('an admin leaving while another demotes them: no deadlock, and an admin is left', async () => {
		const { realmId, slug, low, high } = await twoAdmins();
		try {
			const { call, grants } = realmApp(database.db);
			grants.realm.set(low, new Set(['can_vouch']));

			const answers = await behindALock(realmId, 2, () => [
				call('POST', `/api/v1/realms/${slug}/leave`, { as: high }),
				call('PATCH', `/api/v1/realms/${slug}/members/${high}`, {
					as: low,
					body: { role: RealmRole.member },
				}),
			]);

			// A deadlock would surface as a 500 on one of them.
			for (const answer of answers) expect(answer.status).toBeLessThan(500);
			expect(await adminsOf(realmId)).toEqual([{ userId: low }]);
		} finally {
			await cleanUp(realmId, [low, high]);
		}
	});
});
