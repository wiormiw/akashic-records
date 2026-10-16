import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { type FitReview, realmEvents } from '@akashic/contracts';
import {
	type Executor,
	inTransaction,
	jobs,
	listings,
	publish,
	realmFitQueue,
	realms,
	type Tx,
} from '@akashic/db';
import { centroidFrom, parseVector, pgVector } from '@akashic/db/sql';
import { CommentSubject, JobStatus, ListingStatus } from '@akashic/lib/enums';
import { EventNotFound, ValidationFailed } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import { policy } from '@/config.ts';
import type {
	AfterStored,
	Centroid,
	CheckFitError,
	DecidedEntry,
	DecideFitError,
	Fit,
	FitDecision,
	InsertPosting,
	Posted,
	PostError,
	PostingDraft,
	PostingsDeps,
	Subject,
	Vector,
} from './postings.types.ts';

// ---- Rules -----------------------------------------------------------------------------------

const rules = policy.realmFit;

export function cosineDistance(a: Vector, b: Vector): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (const [i, x] of a.entries()) {
		const y = b[i] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	// A zero vector is unlike everything, including itself.
	return normA === 0 || normB === 0 ? 2 : 1 - dot / Math.sqrt(normA * normB);
}

/** Moves the centroid a step towards an accepted posting, keeping it unit length. */
export function nudge(centroid: Vector, posting: Vector): number[] {
	const moved = centroid.map(
		(value, i) => value * (1 - rules.learningRate) + (posting[i] ?? 0) * rules.learningRate,
	);
	const norm = Math.hypot(...moved);
	return norm === 0 ? moved : moved.map((value) => value / norm);
}

/**
 * Close is clearly in; far is out, but only once the realm has seen enough postings for its
 * centroid to mean something. Everything between goes to a moderator.
 */
export function judge(distance: number, samples: number): Fit {
	if (distance <= rules.belongs) return 'belongs';
	return distance > rules.doesNotBelong && !stillLearning(samples) ? 'doesNotBelong' : 'uncertain';
}

/** Whether the realm has seen too few postings for its centroid to refuse anything yet. */
export const stillLearning = (samples: number): boolean => samples < rules.minSamplesToRefuse;

// ---- Queries ---------------------------------------------------------------------------------

/**
 * Reads the realm table directly: modules share tables, not code. `lock` holds the row until the
 * transaction ends, so a read-then-nudge inside one can't lose another's nudge.
 */
async function centroidOf(db: Executor, realmId: string, lock = false): Promise<Centroid> {
	const query = db
		.select({
			centroid: sql<string | null>`${realms.centroid}::text`,
			samples: realms.centroidSamples,
		})
		.from(realms)
		.where(eq(realms.id, realmId))
		.limit(1);
	return centroidFrom((await (lock ? query.for('update') : query))[0]);
}

async function setCentroid(
	db: Executor,
	realmId: string,
	centroid: Vector,
	now: Date,
): Promise<void> {
	await db
		.update(realms)
		.set({
			centroid: sql`${pgVector(centroid)}::vector`,
			centroidSamples: sql`${realms.centroidSamples} + 1`,
			updatedAt: now,
		})
		.where(eq(realms.id, realmId));
}

/** Queuing a posting again re-opens its entry. */
async function queueForReview(
	db: Executor,
	realmId: string,
	subject: Subject,
	distance: number,
	vector: Vector,
): Promise<void> {
	const embedding = sql`${pgVector(vector)}::vector`;
	await db
		.insert(realmFitQueue)
		.values({ realmId, subjectKind: subject.kind, subjectId: subject.id, distance, embedding })
		.onConflictDoUpdate({
			target: [realmFitQueue.subjectKind, realmFitQueue.subjectId],
			set: { distance, embedding, kept: null, decidedAt: null },
		});
}

/** Undefined when there is no undecided entry with that id in the realm. */
async function decideReview(
	db: Executor,
	realmId: string,
	entryId: string,
	moderatorId: string,
	kept: boolean,
	now: Date,
): Promise<DecidedEntry | undefined> {
	const [row] = await db
		.update(realmFitQueue)
		.set({ kept, keptBy: moderatorId, decidedAt: now })
		.where(
			and(
				eq(realmFitQueue.id, entryId),
				eq(realmFitQueue.realmId, realmId),
				isNull(realmFitQueue.kept),
			),
		)
		.returning({
			subjectKind: realmFitQueue.subjectKind,
			subjectId: realmFitQueue.subjectId,
			embedding: sql<string | null>`${realmFitQueue.embedding}::text`,
		});
	return row && { ...row, embedding: row.embedding ? parseVector(row.embedding) : null };
}

// What rejecting a posting does to it; kinds without an entry have nothing to take down.
const takeDown: Partial<
	Record<number, (tx: Tx, realmId: string, id: string, now: Date) => Promise<unknown>>
> = {
	[CommentSubject.job]: (tx, realmId, id, now) =>
		tx
			.update(jobs)
			.set({ status: JobStatus.closed, updatedAt: now })
			.where(and(eq(jobs.id, id), eq(jobs.realmId, realmId))),
	[CommentSubject.listing]: (tx, realmId, id, now) =>
		tx
			.update(listings)
			.set({ status: ListingStatus.removed, updatedAt: now })
			.where(and(eq(listings.id, id), eq(listings.realmId, realmId))),
};

// ---- Service ---------------------------------------------------------------------------------

/** Whether a posting fits its realm, the moderators' queue for those in between, and learning. */
export function createFitService(deps: PostingsDeps) {
	const { db, embedder, clock } = deps;
	const log = deps.logger.child({ component: 'postings' });

	/**
	 * Refuses a posting that clearly doesn't belong, and returns what to do once it is stored:
	 * teach a young realm's centroid, or queue an uncertain posting for a moderator.
	 */
	async function check(draft: PostingDraft): Promise<Result<AfterStored, CheckFitError>> {
		const { realmId, kind } = draft;
		const nothing = ok<AfterStored>(async () => {});
		const { centroid, samples } = await centroidOf(db, realmId);
		const embedding = centroid && (await embedder.embed(`${draft.title}\n\n${draft.description}`));
		if (!centroid || !embedding) return nothing;

		const distance = cosineDistance(embedding, centroid);
		const fit = judge(distance, samples);
		if (fit === 'doesNotBelong') {
			return err(
				new ValidationFailed(
					'This does not look like it belongs in this realm. Post it where its readers are, ' +
						'or ask a moderator if you think this is wrong.',
				),
			);
		}
		if (stillLearning(samples)) {
			// Unlocked, as before: a young realm's nudge is a best-effort follow-up after the commit,
			// and the slow model call above must not hold the realm row.
			return ok(async () =>
				setCentroid(db, realmId, nudge(centroid, embedding), toDate(clock.now())),
			);
		}
		if (fit === 'uncertain') {
			return ok((id: string) => queueForReview(db, realmId, { kind, id }, distance, embedding));
		}
		return nothing;
	}

	/** Moves the realm's centroid toward a posting a moderator kept, once there is one to move. */
	async function learn(tx: Tx, realmId: string, embedding: Vector | null) {
		if (!embedding) return;
		const { centroid } = await centroidOf(tx, realmId, true);
		if (centroid) await setCentroid(tx, realmId, nudge(centroid, embedding), toDate(clock.now()));
	}

	return {
		/** Stores a posting that fits its realm, announces it, then acts on what the check found. */
		async admit(draft: PostingDraft, insert: InsertPosting): Promise<Result<Posted, PostError>> {
			const { realmId, authorId } = draft;
			const fit = await check(draft);
			if (!fit.ok) return fit;
			const id = await inTransaction(db, async (tx) => {
				const created = await insert(tx);
				await publish(
					tx,
					[realmEvents.postingCreated(draft.type, { postingId: created, realmId, authorId })],
					clock.now(),
				);
				return ok(created);
			});
			// After the commit: learning or queueing is a follow-up, not part of the posting. The
			// posting is stored either way, so a failure here is logged, not answered: a 500 would make
			// the client retry and post it twice.
			try {
				await fit.value(id.value);
			} catch (error) {
				log.error({ err: error, postingId: id.value, realmId }, 'posting follow-up failed');
			}
			return ok({ id: id.value });
		},

		/** Undecided entries, oldest first. */
		async reviewQueue(realmId: string): Promise<FitReview[]> {
			const rows = await db
				.select({
					id: realmFitQueue.id,
					subjectKind: realmFitQueue.subjectKind,
					subjectId: realmFitQueue.subjectId,
					distance: realmFitQueue.distance,
					createdAt: realmFitQueue.createdAt,
				})
				.from(realmFitQueue)
				.where(and(eq(realmFitQueue.realmId, realmId), isNull(realmFitQueue.kept)))
				.orderBy(asc(realmFitQueue.createdAt))
				.limit(policy.pageSize);
			return rows.map((row) => ({ ...row, createdAt: fromDate(row.createdAt) }));
		},

		/** Keeping a posting teaches the centroid; rejecting takes the posting down. */
		decide(
			realmId: string,
			entryId: string,
			moderatorId: string,
			kept: boolean,
		): Promise<Result<FitDecision, DecideFitError>> {
			// One transaction, so a decision never stands without what it does to the posting.
			return inTransaction(db, async (tx) => {
				const now = toDate(clock.now());
				const decided = await decideReview(tx, realmId, entryId, moderatorId, kept, now);
				if (!decided) {
					return err(new EventNotFound('Nothing waiting under that id. Already decided?'));
				}
				if (kept) await learn(tx, realmId, decided.embedding);
				else await takeDown[decided.subjectKind]?.(tx, realmId, decided.subjectId, now);
				return ok({ kept });
			});
		},
	};
}
