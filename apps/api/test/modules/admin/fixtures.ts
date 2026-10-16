import { eq } from 'drizzle-orm';
import * as v from 'valibot';
import { realmMembers, realms, roomMessages, roomReports, rooms, type Tx, user } from '@akashic/db';
import { RealmRole, RoomSubject } from '@akashic/lib/enums';
import { createAdminService } from '@/modules/admin/admin.service.ts';
import { clock, person, uniqueSlug } from '../../support/fixtures.ts';

/** The admin service on `tx`, and the rows the scenarios start from. */
export function world(tx: Tx) {
	const admin = createAdminService({ db: tx, clock });

	/** A realm inserted directly, with `adminCount` admins (the founder is the first) and `members` more. */
	async function realm(adminCount = 1, members = 0) {
		const founder = await person(tx, 'Founder');
		const slug = uniqueSlug();
		const [row] = await tx
			.insert(realms)
			.values({ slug, name: 'Test realm', createdBy: founder })
			.returning({ id: realms.id });
		const id = row!.id;
		const people: string[] = [];
		for (let i = 0; i < adminCount + members; i++) {
			const who = i === 0 ? founder : await person(tx, `Member ${i}`);
			await tx.insert(realmMembers).values({
				realmId: id,
				userId: who,
				role: i < adminCount ? RealmRole.admin : RealmRole.member,
			});
			people.push(who);
		}
		return { id, slug, founder, people };
	}

	/** A report of `accused` by `reporter`, about a real message from `sender`. */
	async function report(reporter: string, accused: string, sender = accused) {
		const [low, high] = [reporter, accused].sort() as [string, string];
		const { id: realmId } = await realm();
		const [room] = await tx
			.insert(rooms)
			.values({
				realmId,
				subjectKind: RoomSubject.listing,
				subjectId: Bun.randomUUIDv7(),
				lowUserId: low,
				highUserId: high,
			})
			.returning({ id: rooms.id });
		const [message] = await tx
			.insert(roomMessages)
			.values({ roomId: room!.id, senderId: sender, body: 'cipher', iv: 'iv-12345678' })
			.returning({ id: roomMessages.id });
		const [row] = await tx
			.insert(roomReports)
			.values({
				roomId: room!.id,
				messageId: message!.id,
				reporterId: reporter,
				accusedId: accused,
				reason: 'Rude.',
				disclosedText: 'what they said',
				// Open reports list oldest first: backdated, this one is always on the first page
				// however many open reports the database already holds.
				createdAt: new Date(0),
			})
			.returning({ id: roomReports.id });
		return row!.id;
	}

	return {
		tx,
		admin,
		realm,
		report,
		person: (name?: string) => person(tx, name),
		/** An account with a known, unique email. */
		async account(name = 'Someone') {
			const id = await person(tx, name);
			const [row] = await tx.select({ email: user.email }).from(user).where(eq(user.id, id));
			return { id, email: row!.email };
		},
	};
}

export type World = ReturnType<typeof world>;

// The web app's schemas (akashic_records_fe/src/lib/api/platform.ts), copied: every response
// must parse with what the browser parses it with.
const Account = v.object({ id: v.string(), name: v.string(), email: v.string() });

export const Web = {
	Overview: v.object({
		realms: v.number(),
		archived: v.number(),
		orphaned: v.number(),
		members: v.number(),
		openReports: v.number(),
		auditEntries: v.number(),
	}),
	PlatformRealm: v.object({
		id: v.string(),
		slug: v.string(),
		name: v.string(),
		category: v.nullable(v.string()),
		memberCount: v.number(),
		adminCount: v.number(),
		archivedAt: v.nullable(v.string()),
		createdAt: v.string(),
		createdBy: v.nullable(Account),
	}),
	AuditEntry: v.object({
		id: v.string(),
		actor: v.nullable(Account),
		entityType: v.string(),
		entityId: v.string(),
		action: v.number(),
		changes: v.nullable(v.record(v.string(), v.unknown())),
		traceId: v.nullable(v.string()),
		occurredAt: v.string(),
	}),
	Report: v.object({
		id: v.string(),
		roomId: v.string(),
		messageId: v.nullable(v.string()),
		reason: v.string(),
		disclosedText: v.nullable(v.string()),
		reporter: v.nullable(Account),
		accused: v.nullable(Account),
		senderMatches: v.nullable(v.boolean()),
		reviewedAt: v.nullable(v.string()),
		createdAt: v.string(),
	}),
	PlatformAccount: v.object({
		id: v.string(),
		name: v.string(),
		email: v.string(),
		emailVerified: v.boolean(),
		createdAt: v.string(),
		bannedAt: v.nullable(v.string()),
		banReason: v.nullable(v.string()),
		bannedUntil: v.nullable(v.string()),
		realmCount: v.number(),
	}),
};
