import { and, eq, sql } from 'drizzle-orm';
import {
	auditEntries,
	events,
	jobs,
	listings,
	postingInterests,
	realmFitQueue,
	realmMembers,
	realmModules,
	realms,
	type Tx,
} from '@akashic/db';
import { centroidFrom, pgVector } from '@akashic/db/sql';
import { CommentSubject, RealmModule, RealmRole } from '@akashic/lib/enums';
import { type Logger, silentLogger } from '@akashic/lib/log';
import { EMBEDDING_DIMENSIONS, type Embedder } from '@/integrations/embedder.ts';
import { createPostingServices } from '@/modules/postings/postings.module.ts';
import { clock, outbox, person, uniqueSlug } from '../../support/fixtures.ts';

/** A full-width embedding whose first numbers are `head`, the rest zero. */
export const vec = (...head: number[]): number[] => [
	...head,
	...Array.from({ length: EMBEDDING_DIMENSIONS - head.length }, () => 0),
];

export const CENTROID = vec(1, 0);
export const BELONGS = vec(1, 0); // distance 0
export const UNCERTAIN = vec(0.82, Math.sqrt(1 - 0.82 ** 2)); // distance 0.18, between the lines
export const FAR = vec(0, 1); // distance 1

/** An embedder that answers `embedding` for any text; `null` is an unavailable model. */
export const embedderOf = (embedding: number[] | null = null): Embedder => ({
	available: embedding !== null,
	embed: async () => embedding,
});

/** pgvector stores float4: compare a stored vector to the expected one to that precision. */
export function closeTo(actual: number[] | null, expected: number[]): boolean {
	if (!actual || actual.length !== expected.length) return false;
	return actual.every((value, i) => Math.abs(value - expected[i]!) < 1e-5);
}

/** The postings services on `tx`, and the rows the scenarios start from. */
export function world(tx: Tx, embedder: Embedder = embedderOf(), logger: Logger = silentLogger()) {
	const services = createPostingServices({ db: tx, embedder, clock, logger });

	async function realm(options: { members?: number; centroid?: number[]; samples?: number } = {}) {
		const admin = await person(tx, 'Founder');
		const [row] = await tx
			.insert(realms)
			.values({ slug: uniqueSlug(), name: 'Test realm', createdBy: admin })
			.returning({ id: realms.id });
		const id = row!.id;
		await tx
			.insert(realmModules)
			.values([RealmModule.jobs, RealmModule.market].map((module) => ({ realmId: id, module })));
		await tx.insert(realmMembers).values({ realmId: id, userId: admin, role: RealmRole.admin });
		const people: string[] = [];
		for (let i = 0; i < (options.members ?? 0); i++) {
			const member = await person(tx, `Member ${i}`);
			await tx.insert(realmMembers).values({ realmId: id, userId: member, role: RealmRole.member });
			people.push(member);
		}
		if (options.centroid) {
			await tx
				.update(realms)
				.set({
					centroid: sql`${pgVector(options.centroid)}::vector`,
					centroidSamples: options.samples ?? 0,
				})
				.where(eq(realms.id, id));
		}
		const [slugRow] = await tx.select({ slug: realms.slug }).from(realms).where(eq(realms.id, id));
		return { id, slug: slugRow!.slug, admin, people };
	}

	/** A job and a listing, inserted directly: the fit check is not what these scenarios test. */
	async function seed(realmId: string, authorId: string) {
		const [job] = await tx
			.insert(jobs)
			.values({ realmId, authorId, title: 'Commission', description: 'Draw a banner.' })
			.returning({ id: jobs.id });
		const [listing] = await tx
			.insert(listings)
			.values({
				realmId,
				sellerId: authorId,
				title: 'Print',
				description: 'An A4 print.',
				priceCents: 1500,
			})
			.returning({ id: listings.id });
		return {
			job: { kind: CommentSubject.job, id: job!.id },
			listing: { kind: CommentSubject.listing, id: listing!.id },
		};
	}

	async function event(realmId: string, authorId: string) {
		const [row] = await tx
			.insert(events)
			.values({
				realmId,
				authorId,
				title: 'Meetup',
				description: 'Come along.',
				startsAt: new Date('2030-01-01T00:00:00Z'),
			})
			.returning({ id: events.id });
		return { kind: CommentSubject.event, id: row!.id };
	}

	/** A waiting fit-queue entry for `subject`. */
	async function queued(
		realmId: string,
		subject: { kind: number; id: string },
		embedding: number[] | null,
	) {
		const [row] = await tx
			.insert(realmFitQueue)
			.values({
				realmId,
				subjectKind: subject.kind,
				subjectId: subject.id,
				distance: 0.18,
				embedding: embedding && sql`${pgVector(embedding)}::vector`,
			})
			.returning({ id: realmFitQueue.id });
		return row!.id;
	}

	return {
		...services,
		tx,
		person: (name?: string) => person(tx, name),
		realm,
		seed,
		event,
		queued,
		outbox: (type: string, realmId: string) => outbox(tx, type, realmId),
		/** Turns a module off for the realm. */
		disable: (realmId: string, module: RealmModule) =>
			tx
				.delete(realmModules)
				.where(and(eq(realmModules.realmId, realmId), eq(realmModules.module, module))),
		join: (realmId: string, userId: string) =>
			tx.insert(realmMembers).values({ realmId, userId, role: RealmRole.member }),
		async centroid(realmId: string) {
			const [row] = await tx
				.select({
					centroid: sql<string | null>`${realms.centroid}::text`,
					samples: realms.centroidSamples,
				})
				.from(realms)
				.where(eq(realms.id, realmId));
			return centroidFrom(row);
		},
		async job(id: string) {
			const [row] = await tx.select().from(jobs).where(eq(jobs.id, id));
			return row;
		},
		audits: (entityId: string) =>
			tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId)),
		async listing(id: string) {
			const [row] = await tx.select().from(listings).where(eq(listings.id, id));
			return row;
		},
		jobsIn: (realmId: string) => tx.select().from(jobs).where(eq(jobs.realmId, realmId)),
		queue: (realmId: string) =>
			tx.select().from(realmFitQueue).where(eq(realmFitQueue.realmId, realmId)),
		async interestOf(subjectId: string, userId: string) {
			const rows = await tx
				.select()
				.from(postingInterests)
				.where(eq(postingInterests.subjectId, subjectId));
			return rows.find((row) => row.userId === userId)?.status;
		},
	};
}
