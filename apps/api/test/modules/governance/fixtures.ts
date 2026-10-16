import { and, eq } from 'drizzle-orm';
import * as v from 'valibot';
import {
	auditEntries,
	comments,
	events,
	realmEndorsements,
	realmMembers,
	realmModules,
	realms,
	recalls,
	takedowns,
	type Tx,
} from '@akashic/db';
import { CommentSubject, narrow, RealmModule, RealmRole } from '@akashic/lib/enums';
import { createGovernanceServices } from '@/modules/governance/governance.module.ts';
import { clock, outbox, person, uniqueSlug } from '../../support/fixtures.ts';

/** The governance services on `tx`, and the rows the scenarios start from. */
export function world(tx: Tx) {
	const services = createGovernanceServices({ db: tx, clock });

	/** A realm with an admin founder and `members` plain members, inserted directly. */
	async function realm(members = 0, modules: RealmModule[] = [RealmModule.election]) {
		const admin = await person(tx, 'Founder');
		const slug = uniqueSlug();
		const [row] = await tx
			.insert(realms)
			.values({ slug, name: 'Test realm', createdBy: admin })
			.returning({ id: realms.id });
		const id = row!.id;
		if (modules.length > 0) {
			await tx.insert(realmModules).values(modules.map((module) => ({ realmId: id, module })));
		}
		await tx.insert(realmMembers).values({ realmId: id, userId: admin, role: RealmRole.admin });
		const people: string[] = [];
		for (let i = 0; i < members; i++) {
			const member = await person(tx, `Member ${i}`);
			// Distinct join times, so seniority breaks ties the same way every run.
			await tx.insert(realmMembers).values({
				realmId: id,
				userId: member,
				role: RealmRole.member,
				joinedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
			});
			people.push(member);
		}
		return { id, slug, admin, people };
	}

	/** Sets a role directly, publishing nothing: setup, not the change under test. */
	async function setRole(realmId: string, userId: string, role: RealmRole) {
		await tx
			.update(realmMembers)
			.set({ role })
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)));
	}

	async function roleOf(realmId: string, userId: string) {
		const [row] = await tx
			.select({ role: realmMembers.role })
			.from(realmMembers)
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)));
		return row ? narrow(RealmRole, row.role) : null;
	}

	/** Upvotes inserted directly, without reconciling seats. */
	async function upvotes(realmId: string, candidateId: string, voters: readonly string[]) {
		await tx
			.insert(realmEndorsements)
			.values(voters.map((endorserId) => ({ realmId, endorserId, candidateId })));
	}

	/** A comment under a fresh event, inserted directly: the comments module isn't what's tested. */
	async function comment(realmId: string, authorId: string) {
		const [event] = await tx
			.insert(events)
			.values({
				realmId,
				authorId,
				title: 'Meetup',
				description: 'Come along.',
				startsAt: new Date('2030-01-01T00:00:00Z'),
			})
			.returning({ id: events.id });
		const [row] = await tx
			.insert(comments)
			.values({
				realmId,
				subjectKind: CommentSubject.event,
				subjectId: event!.id,
				authorId,
				body: 'rude words',
			})
			.returning({ id: comments.id });
		return row!.id;
	}

	return {
		...services,
		person: (name?: string) => person(tx, name),
		realm,
		setRole,
		roleOf,
		upvotes,
		comment,
		outbox: (type: string, realmId: string) => outbox(tx, type, realmId),
		async memberChanges(realmId: string) {
			return (await outbox(tx, 'realm.member_changed', realmId)).map((row) => row.payload);
		},
		async audits(entityId: string) {
			return tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId));
		},
		async endorsementsOf(realmId: string, candidateId: string) {
			return tx
				.select()
				.from(realmEndorsements)
				.where(
					and(
						eq(realmEndorsements.realmId, realmId),
						eq(realmEndorsements.candidateId, candidateId),
					),
				);
		},
		async commentRow(id: string) {
			const [row] = await tx.select().from(comments).where(eq(comments.id, id));
			return row;
		},
		async recallRow(id: string) {
			const [row] = await tx.select().from(recalls).where(eq(recalls.id, id));
			return row;
		},
		async takedownRows(realmId: string) {
			return tx.select().from(takedowns).where(eq(takedowns.realmId, realmId));
		},
	};
}

export type World = ReturnType<typeof world>;

// The web app's schemas (akashic_records_fe/src/lib/api/governance.ts), copied: every response
// the web app reads must parse with what the browser parses it with. Its writes read the body
// as `unknown`, so only the three reads have a schema there.
const NamedUser = v.nullable(v.object({ id: v.string(), name: v.string() }));

export const Web = {
	Standings: v.object({
		seats: v.number(),
		minimum: v.number(),
		members: v.array(
			v.object({
				userId: v.string(),
				name: v.string(),
				role: v.number(),
				upvotes: v.number(),
				seated: v.boolean(),
				joinedAt: v.string(),
			}),
		),
	}),
	Recall: v.object({
		id: v.string(),
		realmId: v.string(),
		subject: NamedUser,
		kind: v.number(),
		reason: v.string(),
		proposedBy: NamedUser,
		status: v.number(),
		agrees: v.number(),
		refusals: v.number(),
		createdAt: v.string(),
	}),
	Takedown: v.object({
		id: v.string(),
		realmId: v.string(),
		subjectKind: v.number(),
		subjectId: v.string(),
		reason: v.string(),
		proposedBy: NamedUser,
		status: v.number(),
		agrees: v.number(),
		refusals: v.number(),
		needed: v.number(),
		createdAt: v.string(),
	}),
};
