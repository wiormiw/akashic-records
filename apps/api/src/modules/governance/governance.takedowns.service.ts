import { and, asc, eq, type SQL, sql } from 'drizzle-orm';
import type { PendingTakedown, Takedown, Votes } from '@akashic/contracts';
import {
	audit,
	comments,
	type Executor,
	inTransaction,
	takedowns,
	takedownVotes,
	user,
} from '@akashic/db';
import { first, one } from '@akashic/db/sql';
import { AuditAction, CommentSubject, narrow, TakedownStatus } from '@akashic/lib/enums';
import { AlreadyMember, RealmNotFound } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import { cannotCarry, majority, sizeOf } from './governance.seats.service.ts';
import type {
	GovernanceDeps,
	NewTakedown,
	ProposeTakedownError,
	TakedownOpened,
	TakedownTally,
	VoteTakedownError,
} from './governance.types.ts';

// ---- Rules -----------------------------------------------------------------------------------

/** With fewer than three moderators there's no quorum to wait for: one can act alone. */
export const actsAlone = (moderators: number): boolean => moderators < 3;

// ---- Queries ---------------------------------------------------------------------------------

/** Takedowns with their tallies, oldest first; `where` carries the realm or the id. */
async function selectTakedowns(
	db: Executor,
	where: SQL | undefined,
	limit: number,
): Promise<Takedown[]> {
	const rows = await db
		.select({
			id: takedowns.id,
			realmId: takedowns.realmId,
			subjectKind: takedowns.subjectKind,
			subjectId: takedowns.subjectId,
			reason: takedowns.reason,
			status: takedowns.status,
			createdAt: takedowns.createdAt,
			proposerId: user.id,
			proposerName: user.name,
			agrees: sql<number>`count(*) FILTER (WHERE ${takedownVotes.agree})`.mapWith(Number),
			refusals: sql<number>`count(*) FILTER (WHERE NOT ${takedownVotes.agree})`.mapWith(Number),
		})
		.from(takedowns)
		.leftJoin(user, eq(user.id, takedowns.proposedBy))
		.leftJoin(takedownVotes, eq(takedownVotes.takedownId, takedowns.id))
		.where(where)
		.groupBy(takedowns.id, user.id)
		.orderBy(asc(takedowns.createdAt))
		.limit(limit);
	return rows.map((row) => ({
		id: row.id,
		realmId: row.realmId,
		subjectKind: narrow(CommentSubject, row.subjectKind),
		subjectId: row.subjectId,
		reason: row.reason,
		status: narrow(TakedownStatus, row.status),
		agrees: row.agrees,
		refusals: row.refusals,
		proposedBy: row.proposerId ? { id: row.proposerId, name: row.proposerName ?? '' } : null,
		createdAt: fromDate(row.createdAt),
	}));
}

async function findTakedown(db: Executor, id: string): Promise<Takedown | undefined> {
	const takedown = first(await selectTakedowns(db, eq(takedowns.id, id), 1));
	return takedown;
}

/** Records the vote, replacing the voter's earlier one, and answers the tally after it. */
async function castVote(
	db: Executor,
	takedownId: string,
	voterId: string,
	agree: boolean,
): Promise<Votes> {
	await db
		.insert(takedownVotes)
		.values({ takedownId, voterId, agree })
		.onConflictDoUpdate({
			target: [takedownVotes.takedownId, takedownVotes.voterId],
			set: { agree },
		});
	return one(
		await db
			.select({
				agrees: sql<number>`count(*) FILTER (WHERE ${takedownVotes.agree})`.mapWith(Number),
				refusals: sql<number>`count(*) FILTER (WHERE NOT ${takedownVotes.agree})`.mapWith(Number),
			})
			.from(takedownVotes)
			.where(eq(takedownVotes.takedownId, takedownId)),
		'takedown tally',
	);
}

/** Only an open takedown resolves; false when it was already settled. */
async function resolve(
	db: Executor,
	id: string,
	status: TakedownStatus,
	at: Date,
): Promise<boolean> {
	const updated = await db
		.update(takedowns)
		.set({ status, resolvedAt: at })
		.where(and(eq(takedowns.id, id), eq(takedowns.status, TakedownStatus.open)))
		.returning({ id: takedowns.id });
	return updated.length > 0;
}

/** Undefined when a takedown is already open against that comment. */
async function openTakedown(db: Executor, takedown: NewTakedown): Promise<string | undefined> {
	const { commentId, ...rest } = takedown;
	const created = first(
		await db
			.insert(takedowns)
			.values({ ...rest, subjectId: commentId })
			.onConflictDoNothing()
			.returning({ id: takedowns.id }),
	);
	return created?.id;
}

/** Whether the comment is one of this realm's: a comment elsewhere is indistinguishable from none. */
async function commentInRealm(db: Executor, realmId: string, commentId: string): Promise<boolean> {
	const row = first(
		await db
			.select({ id: comments.id })
			.from(comments)
			.where(and(eq(comments.id, commentId), eq(comments.realmId, realmId)))
			.limit(1),
	);
	return row !== undefined;
}

/** Soft delete, as the comments module does it: the comment keeps its place in the thread. */
async function removeComment(db: Executor, realmId: string, commentId: string, at: Date) {
	await db
		.update(comments)
		.set({ removedAt: at })
		.where(and(eq(comments.id, commentId), eq(comments.realmId, realmId)));
}

// ---- Service ---------------------------------------------------------------------------------

export function createTakedownService(deps: GovernanceDeps) {
	const { db, clock } = deps;

	return {
		/** Open takedowns, each with the agreement it needs: the same majority a vote is tallied by. */
		async openTakedowns(realmId: string, limit: number): Promise<PendingTakedown[]> {
			const [size, rows] = await Promise.all([
				sizeOf(db, realmId),
				selectTakedowns(
					db,
					and(eq(takedowns.realmId, realmId), eq(takedowns.status, TakedownStatus.open)),
					limit,
				),
			]);
			const needed = majority(size.moderators);
			return rows.map((row) => ({ ...row, needed }));
		},

		/** Opens a vote to remove a comment; a lone moderator's takedown carries at once. */
		proposeTakedown(
			realmId: string,
			commentId: string,
			reason: string,
			proposerId: string,
		): Promise<Result<TakedownOpened, ProposeTakedownError>> {
			return inTransaction(db, async (tx) => {
				// Scoped to the realm in the path, so a moderator elsewhere can't take this comment down.
				if (!(await commentInRealm(tx, realmId, commentId))) {
					return err(new RealmNotFound('No such comment in this realm.'));
				}
				const size = await sizeOf(tx, realmId);
				const id = await openTakedown(tx, { realmId, commentId, reason, proposedBy: proposerId });
				if (!id) {
					return err(
						new AlreadyMember(
							'A takedown is already open against that comment. Vote on it instead.',
						),
					);
				}
				await castVote(tx, id, proposerId, true);

				if (!actsAlone(size.moderators))
					return ok({ id, carried: false, agrees: 1, needed: majority(size.moderators) });

				const now = toDate(clock.now());
				await removeComment(tx, realmId, commentId, now);
				await resolve(tx, id, TakedownStatus.carried, now);
				await audit(tx, {
					actorId: proposerId,
					entityType: 'comment',
					entityId: commentId,
					action: AuditAction.moderated,
					changes: { realmId, reason, removed: true, sole: true },
				});
				return ok({ id, carried: true, agrees: 1, needed: 1 });
			});
		},

		async voteOnTakedown(
			realmId: string,
			takedownId: string,
			voterId: string,
			agree: boolean,
		): Promise<Result<TakedownTally, VoteTakedownError>> {
			const takedown = await findTakedown(db, takedownId);
			// Scoped to the realm in the path, so a moderator elsewhere can't vote here.
			if (!takedown || takedown.realmId !== realmId)
				return err(new RealmNotFound('No such takedown.'));
			if (takedown.status !== TakedownStatus.open) {
				return err(new AlreadyMember('That takedown is already settled.'));
			}

			return inTransaction(db, async (tx) => {
				const size = await sizeOf(tx, realmId);
				const needed = majority(size.moderators);
				const { agrees, refusals } = await castVote(tx, takedownId, voterId, agree);
				const now = toDate(clock.now());

				if (agrees >= needed) {
					// A concurrent vote that resolved it first has removed the comment already.
					if (await resolve(tx, takedownId, TakedownStatus.carried, now)) {
						await removeComment(tx, realmId, takedown.subjectId, now);
						await audit(tx, {
							actorId: voterId,
							entityType: 'comment',
							entityId: takedown.subjectId,
							action: AuditAction.moderated,
							changes: { realmId, reason: takedown.reason, removed: true, agrees },
						});
					}
					return ok({ status: TakedownStatus.carried, agrees, refusals, needed });
				}
				if (cannotCarry(refusals, size.moderators, needed)) {
					await resolve(tx, takedownId, TakedownStatus.refused, now);
					return ok({ status: TakedownStatus.refused, agrees, refusals, needed });
				}
				return ok({ status: TakedownStatus.open, agrees, refusals, needed });
			});
		},
	};
}
