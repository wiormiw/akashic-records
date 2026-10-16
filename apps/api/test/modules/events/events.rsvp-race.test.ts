import { afterAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { Relation } from '@akashic/authz';
import {
	createDb,
	eventRsvps,
	events,
	outboxMessages,
	realmMembers,
	realmModules,
	realms,
	user,
} from '@akashic/db';
import { RealmModule, RealmRole, RsvpStatus } from '@akashic/lib/enums';
import { silentLogger } from '@akashic/lib/log';
import { eventsApp } from './app.ts';
import { clock, databaseUrl, uniqueSlug } from '../../support/fixtures.ts';

// Two RSVPs for the last place need two connections, so this can't run inside one rolled-back
// transaction: it commits its own uniquely named rows and deletes exactly those afterwards.

const database = createDb({
	url: databaseUrl,
	poolMax: 8,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)('RSVPs at the same moment', () => {
	test('two going for the last place: one is 200, the other 409 event.at_capacity', async () => {
		const { db } = database;
		const tag = Bun.randomUUIDv7();
		const [founder, a, b] = [Bun.randomUUIDv7(), Bun.randomUUIDv7(), Bun.randomUUIDv7()];
		const slug = uniqueSlug('race');
		let realmId: string | undefined;
		try {
			await db.insert(user).values(
				[founder, a, b].map((id, i) => ({
					id,
					name: `Racer ${i}`,
					email: `race-${i}-${tag}@example.test`,
				})),
			);
			const [realm] = await db
				.insert(realms)
				.values({ slug, name: 'Race', createdBy: founder })
				.returning({ id: realms.id });
			realmId = realm!.id;
			await db.insert(realmModules).values({ realmId, module: RealmModule.events });
			await db
				.insert(realmMembers)
				.values(
					[founder, a, b].map((userId) => ({ realmId: realmId!, userId, role: RealmRole.member })),
				);
			const [event] = await db
				.insert(events)
				.values({
					realmId,
					authorId: founder,
					title: 'Last seat',
					description: 'One place.',
					startsAt: new Date(clock.now().add({ hours: 24 }).epochMilliseconds),
					capacity: 1,
				})
				.returning({ id: events.id });
			const eventId = event!.id;

			const { call, grant } = eventsApp(db);
			grant(a, Relation.realm.participate);
			grant(b, Relation.realm.participate);
			const answers = await Promise.all(
				[a, b].map((as) =>
					call('PUT', `/api/v1/realms/${slug}/events/${eventId}/rsvp`, {
						as,
						body: { status: RsvpStatus.going },
					}),
				),
			);

			expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
			expect(answers.find((r) => r.status === 409)?.body.code).toBe('event.at_capacity');
			const going = await db.select().from(eventRsvps).where(eq(eventRsvps.eventId, eventId));
			expect(going).toHaveLength(1);
		} finally {
			if (realmId) {
				await db
					.delete(outboxMessages)
					.where(sql`${outboxMessages.payload}->>'realmId' = ${realmId}`);
				// Events, their RSVPs, members and modules cascade from the realm.
				await db.delete(realms).where(eq(realms.id, realmId));
			}
			await db.delete(user).where(sql`${user.id} IN (${founder}, ${a}, ${b})`);
		}
	});
});
