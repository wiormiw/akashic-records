import { afterAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { createDb, outboxMessages, realmMembers, realms, user } from '@akashic/db';
import { RealmRole } from '@akashic/lib/enums';
import { silentLogger } from '@akashic/lib/log';
import { realmApp } from './app.ts';
import { databaseUrl, uniqueSlug } from '../../support/fixtures.ts';

// Two joins at once need two connections, so this can't run inside one rolled-back transaction:
// it commits its own uniquely named rows and deletes exactly those afterwards.

const database = createDb({
	url: databaseUrl,
	poolMax: 8,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)('joining at the same moment', () => {
	test('two joins by one person make one membership and one event; the second is 409', async () => {
		const { db } = database;
		const tag = Bun.randomUUIDv7();
		const [founder, joiner] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
		const slug = uniqueSlug('race');
		let realmId: string | undefined;
		try {
			await db.insert(user).values([
				{ id: founder, name: 'Founder', email: `race-founder-${tag}@example.test` },
				{ id: joiner, name: 'Joiner', email: `race-joiner-${tag}@example.test` },
			]);
			const [realm] = await db
				.insert(realms)
				.values({ slug, name: 'Race', createdBy: founder })
				.returning({ id: realms.id });
			realmId = realm!.id;
			await db.insert(realmMembers).values({ realmId, userId: founder, role: RealmRole.admin });

			const { call } = realmApp(db);
			const answers = await Promise.all([
				call('POST', `/api/v1/realms/${slug}/join`, { as: joiner }),
				call('POST', `/api/v1/realms/${slug}/join`, { as: joiner }),
			]);

			expect(answers.map((a) => a.status).sort()).toEqual([201, 409]);
			expect(answers.find((a) => a.status === 409)?.body.code).toBe('realm.already_member');
			const memberships = await db
				.select()
				.from(realmMembers)
				.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, joiner)));
			expect(memberships).toHaveLength(1);
			const events = await db
				.select({ payload: outboxMessages.payload })
				.from(outboxMessages)
				.where(
					and(
						eq(outboxMessages.messageType, 'realm.member_changed'),
						sql`${outboxMessages.payload}->>'realmId' = ${realmId}`,
					),
				);
			expect(events.map((e) => e.payload)).toEqual([
				{ realmId, userId: joiner, role: RealmRole.member },
			]);
		} finally {
			if (realmId) {
				await db
					.delete(outboxMessages)
					.where(sql`${outboxMessages.payload}->>'realmId' = ${realmId}`);
				// Members and modules cascade from the realm.
				await db.delete(realms).where(eq(realms.id, realmId));
			}
			await db.delete(user).where(sql`${user.id} IN (${founder}, ${joiner})`);
		}
	});
});
