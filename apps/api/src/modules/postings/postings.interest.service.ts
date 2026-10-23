import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Interest } from '@akashic/contracts';
import { type Executor, jobs, listings, postingInterests, realmMembers, user } from '@akashic/db';
import { first, one } from '@akashic/db/sql';
import { CommentSubject, InterestStatus } from '@akashic/lib/enums';
import { EventNotFound, MemberNotFound, RealmForbidden } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import type {
	DropInterestError,
	InterestDeps,
	ListInterestError,
	Posted,
	RequireMemberError,
	ShowInterestError,
	Subject,
	Withdrawn,
} from './postings.types.ts';

const ofSubject = (subject: Subject) =>
	and(eq(postingInterests.subjectKind, subject.kind), eq(postingInterests.subjectId, subject.id));

const noPosting = () => new EventNotFound('No such posting in this realm.');

// ---- Queries the jobs and listings services share --------------------------------------------

export async function hasOpenInterest(
	db: Executor,
	subject: Subject,
	userId: string,
): Promise<boolean> {
	const row = first(
		await db
			.select({ id: postingInterests.id })
			.from(postingInterests)
			.where(
				and(
					ofSubject(subject),
					eq(postingInterests.userId, userId),
					eq(postingInterests.status, InterestStatus.open),
				),
			)
			.limit(1),
	);
	return row !== undefined;
}

/** Accepts the chosen user's interest and declines every other open one. */
export async function settleInterest(
	db: Executor,
	subject: Subject,
	chosenUserId: string,
): Promise<void> {
	await db
		.update(postingInterests)
		.set({
			status: sql`CASE WHEN ${postingInterests.userId} = ${chosenUserId}
        THEN ${InterestStatus.accepted} ELSE ${InterestStatus.declined} END`,
		})
		.where(and(ofSubject(subject), eq(postingInterests.status, InterestStatus.open)));
}

/** Only a member of the realm can be hired or sold to. */
export async function requireMember(
	db: Executor,
	realmId: string,
	userId: string,
): Promise<Result<void, RequireMemberError>> {
	const row = first(
		await db
			.select({ role: realmMembers.role })
			.from(realmMembers)
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)))
			.limit(1),
	);
	if (!row) return err(new MemberNotFound('That person is not in this realm.'));
	return ok(undefined);
}

// ---- Service ---------------------------------------------------------------------------------

/** Hands up for a job or a listing: showing, withdrawing, and who the owner sees. */
export function createInterestService(deps: InterestDeps) {
	const { db, clock } = deps;

	/**
	 * The author of a job or the seller of a listing. Undefined when the realm has no such
	 * posting, so a posting of another realm is indistinguishable from none.
	 */
	async function ownerOf(realmId: string, subject: Subject): Promise<string | undefined> {
		if (subject.kind === CommentSubject.job) {
			const row = first(
				await db
					.select({ owner: jobs.authorId })
					.from(jobs)
					.where(and(eq(jobs.id, subject.id), eq(jobs.realmId, realmId)))
					.limit(1),
			);
			return row?.owner;
		}
		if (subject.kind === CommentSubject.listing) {
			const row = first(
				await db
					.select({ owner: listings.sellerId })
					.from(listings)
					.where(and(eq(listings.id, subject.id), eq(listings.realmId, realmId)))
					.limit(1),
			);
			return row?.owner;
		}
		return undefined;
	}

	return {
		/** Re-opens a withdrawn interest rather than adding a second one. */
		async show(
			realmId: string,
			subject: Subject,
			userId: string,
			note: string | undefined,
		): Promise<Result<Posted, ShowInterestError>> {
			const owner = await ownerOf(realmId, subject);
			if (owner === undefined) return err(noPosting());
			if (owner === userId) {
				return err(new RealmForbidden('That posting is yours.'));
			}
			const row = one(
				await db
					.insert(postingInterests)
					.values({
						realmId,
						subjectKind: subject.kind,
						subjectId: subject.id,
						userId,
						note: note ?? null,
						status: InterestStatus.open,
					})
					.onConflictDoUpdate({
						target: [
							postingInterests.subjectKind,
							postingInterests.subjectId,
							postingInterests.userId,
						],
						set: {
							status: InterestStatus.open,
							note: note ?? null,
							createdAt: toDate(clock.now()),
						},
					})
					.returning({ id: postingInterests.id }),
				'interest upsert',
			);
			return ok({ id: row.id });
		},

		/** A posting of another realm is not found, so nobody withdraws across realms. */
		async drop(
			realmId: string,
			subject: Subject,
			userId: string,
		): Promise<Result<Withdrawn, DropInterestError>> {
			if ((await ownerOf(realmId, subject)) === undefined) return err(noPosting());
			const withdrawn = await db
				.update(postingInterests)
				.set({ status: InterestStatus.withdrawn })
				.where(
					and(
						ofSubject(subject),
						eq(postingInterests.userId, userId),
						eq(postingInterests.status, InterestStatus.open),
					),
				)
				.returning({ id: postingInterests.id });
			return ok({ withdrawn: withdrawn.length > 0 });
		},

		/** Who applied or offered, oldest first. Only the owner, or a moderator, may see. */
		async list(
			realmId: string,
			subject: Subject,
			actorId: string,
			canModerate: boolean,
		): Promise<Result<Interest[], ListInterestError>> {
			const owner = await ownerOf(realmId, subject);
			if (owner === undefined) return err(noPosting());
			if (owner !== actorId && !canModerate) {
				return err(new RealmForbidden('Only the person who posted it can see that.'));
			}
			const rows = await db
				.select({
					id: postingInterests.id,
					userId: postingInterests.userId,
					userName: user.name,
					note: postingInterests.note,
					status: postingInterests.status,
					createdAt: postingInterests.createdAt,
				})
				.from(postingInterests)
				.innerJoin(user, eq(user.id, postingInterests.userId))
				.where(
					and(
						ofSubject(subject),
						inArray(postingInterests.status, [InterestStatus.open, InterestStatus.accepted]),
					),
				)
				.orderBy(asc(postingInterests.createdAt));
			return ok(rows.map((row) => ({ ...row, createdAt: fromDate(row.createdAt) })));
		},
	};
}
