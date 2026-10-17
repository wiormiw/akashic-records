import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { PendingTakedown, Takedown, Votes } from '@akashic/contracts';
import {
	audit,
	comments,
	type Executor,
	inTransaction,
	takedowns,
	takedownVotes,
} from '@akashic/db';
import { AuditAction, CommentSubject, narrow, TakedownStatus } from '@akashic/lib/enums';
import { rowInstant } from '@akashic/db/sql';
import { AlreadyMember, RealmNotFound } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { toDate } from '@akashic/lib/time';
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

type Row = Record<string, unknown>;

const toTakedown = (row: Row): Takedown => ({
	id: String(row.id),
	realmId: String(row.realm_id),
	subjectKind: narrow(CommentSubject, Number(row.subject_kind)),
	subjectId: String(row.subject_id),
	reason: String(row.reason),
	status: narrow(TakedownStatus, Number(row.status)),
	agrees: Number(row.agrees),
	refusals: Number(row.refusals),
	proposedBy: row.proposer_id
		? { id: String(row.proposer_id), name: String(row.proposer_name ?? '') }
		: null,
	createdAt: rowInstant(row.created_at as Date | string),
});

const selectTakedowns = (where: SQL, tail: SQL = sql``) => sql`
  SELECT t.id, t.realm_id, t.subject_kind, t.subject_id, t.reason, t.status, t.created_at,
    u.id AS proposer_id, u.name AS proposer_name,
    count(v.*) FILTER (WHERE v.agree)::int AS agrees,
    count(v.*) FILTER (WHERE NOT v.agree)::int AS refusals
  FROM takedown t
  LEFT JOIN "user" u ON u.id = t.proposed_by
  LEFT JOIN takedown_vote v ON v.takedown_id = t.id
  WHERE ${where}
  GROUP BY t.id, u.id
  ${tail}
`;

async function findTakedown(db: Executor, id: string): Promise<Takedown | undefined> {
	const [row] = (await db.execute(selectTakedowns(sql`t.id = ${id}`))) as unknown as Row[];
	return row && toTakedown(row);
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
	const [row] = (await db.execute(sql`
    SELECT count(*) FILTER (WHERE agree)::int AS agrees,
           count(*) FILTER (WHERE NOT agree)::int AS refusals
    FROM takedown_vote WHERE takedown_id = ${takedownId}
  `)) as unknown as Votes[];
	return { agrees: Number(row?.agrees ?? 0), refusals: Number(row?.refusals ?? 0) };
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
	const [created] = await db
		.insert(takedowns)
		.values({ ...rest, subjectId: commentId })
		.onConflictDoNothing()
		.returning({ id: takedowns.id });
	return created?.id;
}

/** Whether the comment is one of this realm's: a comment elsewhere is indistinguishable from none. */
async function commentInRealm(db: Executor, realmId: string, commentId: string): Promise<boolean> {
	const [row] = await db
		.select({ id: comments.id })
		.from(comments)
		.where(and(eq(comments.id, commentId), eq(comments.realmId, realmId)))
		.limit(1);
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
				db.execute(
					selectTakedowns(
						sql`t.realm_id = ${realmId} AND t.status = ${TakedownStatus.open}`,
						sql`ORDER BY t.created_at ASC LIMIT ${limit}`,
					),
				) as unknown as Promise<Row[]>,
			]);
			const needed = majority(size.moderators);
			return rows.map((row) => ({ ...toTakedown(row), needed }));
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
