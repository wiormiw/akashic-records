import { and, eq } from 'drizzle-orm';
import * as v from 'valibot';
import { eventRsvps, events, realmMembers, realmModules, realms, type Tx } from '@akashic/db';
import { RealmModule, RealmRole } from '@akashic/lib/enums';
import { createEventService } from '@/modules/events/events.service.ts';
import { clock, outbox, person, uniqueSlug } from '../../support/fixtures.ts';

/** The events service on `tx`, and the rows the scenarios start from. */
export function world(tx: Tx) {
	const service = createEventService({ db: tx, clock });
	return {
		service,
		person: (name?: string) => person(tx, name),

		/** A realm with an admin and `members` more people, running `modules`. */
		async realm(modules: number[] = [RealmModule.events], members = 0) {
			const admin = await person(tx, 'Founder');
			const slug = uniqueSlug();
			const [realm] = await tx
				.insert(realms)
				.values({ slug, name: 'Test realm', createdBy: admin })
				.returning({ id: realms.id });
			const id = realm!.id;
			if (modules.length) {
				await tx.insert(realmModules).values(modules.map((module) => ({ realmId: id, module })));
			}
			await tx.insert(realmMembers).values({ realmId: id, userId: admin, role: RealmRole.admin });
			const people: string[] = [];
			for (let i = 0; i < members; i++) {
				const member = await person(tx, `Member ${i}`);
				await tx
					.insert(realmMembers)
					.values({ realmId: id, userId: member, role: RealmRole.member });
				people.push(member);
			}
			return { id, slug, admin, people };
		},

		async rsvpOf(eventId: string, userId: string): Promise<number | null> {
			const [row] = await tx
				.select({ status: eventRsvps.status })
				.from(eventRsvps)
				.where(and(eq(eventRsvps.eventId, eventId), eq(eventRsvps.userId, userId)));
			return row?.status ?? null;
		},

		async eventRow(eventId: string) {
			const [row] = await tx.select().from(events).where(eq(events.id, eventId));
			return row;
		},

		outbox: (type: string, realmId: string) => outbox(tx, type, realmId),
	};
}

// The web app's schemas (akashic_records_fe/src/lib/api/realms.ts), copied: every response must
// parse with what the browser parses it with.
const EventTeaser = v.object({
	id: v.string(),
	title: v.string(),
	startsAt: v.string(),
	capacity: v.nullable(v.number()),
	imageUrl: v.nullable(v.string()),
	goingCount: v.number(),
});
export const Web = {
	EventTeaser,
	EventDetail: v.object({
		...EventTeaser.entries,
		description: v.string(),
		endsAt: v.nullable(v.string()),
		location: v.nullable(v.string()),
		authorId: v.string(),
		authorName: v.string(),
		commentsEnabled: v.boolean(),
		yourRsvp: v.nullable(v.number()),
	}),
};
