import { and, asc, eq, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NamedUser, Recall, Votes } from '@akashic/contracts';
import { type Executor, inTransaction, recalls, recallVotes, user } from '@akashic/db';
import { first, one } from '@akashic/db/sql';
import { narrow, RealmRole, RecallKind, RecallStatus } from '@akashic/lib/enums';
import { AlreadyMember, RealmForbidden, RealmNotFound } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import { cannotCarry, majority, roleOf, sizeOf } from './governance.seats.service.ts';
import type {
	NewRecall,
	ProposeRecallError,
	RecallDeps,
	RecallOpened,
	RecallTally,
	VoteRecallError,
} from './governance.types.ts';

// ---- Rules -----------------------------------------------------------------------------------

/**
 * Votes needed to recall a moderator. The membership needs a simple majority; fellow moderators
 * need 80%, so a clique can't remove a colleague who disagrees with them.
 */
export const recallThreshold = (kind: RecallKind, electorate: number): number =>
	kind === RecallKind.members ? majority(electorate) : Math.max(1, Math.ceil(electorate * 0.8));

/** Whether someone with `role` takes part in a recall of `kind`: a moderators' recall is theirs alone. */
export const mayTakePart = (kind: RecallKind, role: RealmRole | null): boolean =>
	kind === RecallKind.members || (role !== null && role >= RealmRole.moderator);

const notTheirs = () =>
	err(new RealmForbidden("Only moderators propose or vote on a moderators' recall."));

// ---- Queries ---------------------------------------------------------------------------------

const subject = alias(user, 'subject');
const proposer = alias(user, 'proposer');

const person = (id: string | null, name: string | null): NamedUser | null =>
	id ? { id, name: name ?? '' } : null;

/** Recalls with their tallies, oldest first; `where` carries the realm or the id. */
async function selectRecalls(
	db: Executor,
	where: SQL | undefined,
	limit: number,
): Promise<Recall[]> {
	const rows = await db
		.select({
			id: recalls.id,
			realmId: recalls.realmId,
			kind: recalls.kind,
			reason: recalls.reason,
			status: recalls.status,
			createdAt: recalls.createdAt,
			subjectId: subject.id,
			subjectName: subject.name,
			proposerId: proposer.id,
			proposerName: proposer.name,
			agrees: sql<number>`count(*) FILTER (WHERE ${recallVotes.agree})`.mapWith(Number),
			refusals: sql<number>`count(*) FILTER (WHERE NOT ${recallVotes.agree})`.mapWith(Number),
		})
		.from(recalls)
		.leftJoin(subject, eq(subject.id, recalls.subjectId))
		.leftJoin(proposer, eq(proposer.id, recalls.proposedBy))
		.leftJoin(recallVotes, eq(recallVotes.recallId, recalls.id))
		.where(where)
		.groupBy(recalls.id, subject.id, proposer.id)
		.orderBy(asc(recalls.createdAt))
		.limit(limit);
	return rows.map((row) => ({
		id: row.id,
		realmId: row.realmId,
		kind: narrow(RecallKind, row.kind),
		reason: row.reason,
		status: narrow(RecallStatus, row.status),
		agrees: row.agrees,
		refusals: row.refusals,
		subject: person(row.subjectId, row.subjectName),
		proposedBy: person(row.proposerId, row.proposerName),
		createdAt: fromDate(row.createdAt),
	}));
}

async function findRecall(db: Executor, id: string): Promise<Recall | undefined> {
	const recall = first(await selectRecalls(db, eq(recalls.id, id), 1));
	return recall;
}

/** Records the vote, replacing the voter's earlier one, and answers the tally after it. */
async function castVote(
	db: Executor,
	recallId: string,
	voterId: string,
	agree: boolean,
): Promise<Votes> {
	await db
		.insert(recallVotes)
		.values({ recallId, voterId, agree })
		.onConflictDoUpdate({ target: [recallVotes.recallId, recallVotes.voterId], set: { agree } });
	return one(
		await db
			.select({
				agrees: sql<number>`count(*) FILTER (WHERE ${recallVotes.agree})`.mapWith(Number),
				refusals: sql<number>`count(*) FILTER (WHERE NOT ${recallVotes.agree})`.mapWith(Number),
			})
			.from(recallVotes)
			.where(eq(recallVotes.recallId, recallId)),
		'recall tally',
	);
}

/** Only an open recall resolves; false when it was already settled, by a concurrent vote say. */
async function resolve(db: Executor, id: string, status: RecallStatus, at: Date): Promise<boolean> {
	const updated = await db
		.update(recalls)
		.set({ status, resolvedAt: at })
		.where(and(eq(recalls.id, id), eq(recalls.status, RecallStatus.open)))
		.returning({ id: recalls.id });
	return updated.length > 0;
}

/**
 * The recall's status, its row locked for the rest of the transaction. NO KEY UPDATE, the lock
 * `resolve`'s UPDATE takes: FOR UPDATE would conflict with the KEY SHARE lock every concurrent
 * vote's insert holds on the row through its foreign key, and two deciding votes would deadlock.
 */
async function lockStatus(db: Executor, id: string): Promise<RecallStatus> {
	const row = one(
		await db
			.select({ status: recalls.status })
			.from(recalls)
			.where(eq(recalls.id, id))
			.for('no key update'),
		`recall ${id} (it vanished mid-vote)`,
	);
	return narrow(RecallStatus, row.status);
}

/** Undefined when a recall is already open against that member. */
async function openRecall(db: Executor, recall: NewRecall): Promise<string | undefined> {
	const created = first(
		await db.insert(recalls).values(recall).onConflictDoNothing().returning({ id: recalls.id }),
	);
	return created?.id;
}

// ---- Service ---------------------------------------------------------------------------------

export function createRecallService(deps: RecallDeps) {
	const { db, clock, seats } = deps;

	return {
		async openRecalls(realmId: string, limit: number): Promise<Recall[]> {
			return selectRecalls(
				db,
				and(eq(recalls.realmId, realmId), eq(recalls.status, RecallStatus.open)),
				limit,
			);
		},

		async proposeRecall(
			realmId: string,
			subjectId: string,
			kind: RecallKind,
			reason: string,
			proposerId: string,
		): Promise<Result<RecallOpened, ProposeRecallError>> {
			// The electorate is the moderators; anyone else proposing would cast a vote they don't hold.
			if (!mayTakePart(kind, await roleOf(db, realmId, proposerId))) return notTheirs();
			const seat = await seats.requireSeatHolder(
				realmId,
				subjectId,
				'Admins are not recalled. Their standing comes from running the realm, not from a seat.',
			);
			if (!seat.ok) return seat;
			return inTransaction(db, async (tx) => {
				const size = await sizeOf(tx, realmId);
				const electorate = kind === RecallKind.members ? size.members : size.moderators;
				const id = await openRecall(tx, {
					realmId,
					subjectId,
					kind,
					reason,
					proposedBy: proposerId,
				});
				if (!id) {
					return err(
						new AlreadyMember('A recall is already open against them. Vote on it instead.'),
					);
				}
				await castVote(tx, id, proposerId, true);
				return ok({ id, electorate, needed: recallThreshold(kind, electorate) });
			});
		},

		async voteOnRecall(
			realmId: string,
			recallId: string,
			voterId: string,
			agree: boolean,
		): Promise<Result<RecallTally, VoteRecallError>> {
			const recall = await findRecall(db, recallId);
			// Scoped to the realm in the path, so a member elsewhere can't vote here.
			if (!recall || recall.realmId !== realmId) return err(new RealmNotFound('No such recall.'));
			if (recall.status !== RecallStatus.open) {
				return err(new AlreadyMember('That recall is already settled.'));
			}
			if (!mayTakePart(recall.kind, await roleOf(db, realmId, voterId))) return notTheirs();

			return inTransaction(db, async (tx) => {
				const size = await sizeOf(tx, realmId);
				const electorate = recall.kind === RecallKind.members ? size.members : size.moderators;
				const needed = recallThreshold(recall.kind, electorate);
				const { agrees, refusals } = await castVote(tx, recallId, voterId, agree);
				const now = toDate(clock.now());

				if (agrees >= needed) {
					// The recall row first, then the members, the order carrying always took. A concurrent
					// vote that settled it first has done (or declined) the unseating already.
					const status = await lockStatus(tx, recallId);
					if (status !== RecallStatus.open) return ok({ status, agrees, refusals, needed });
					// Read under the members' lock. A subject promoted to admin, demoted or gone since the
					// recall opened holds no seat to take: refused, so the recall neither sticks open nor
					// carries later against a seat they hold again.
					const subjectId = recall.subject?.id;
					if (!subjectId || !(await seats.lockSeatHolder(tx, realmId, subjectId))) {
						await resolve(tx, recallId, RecallStatus.refused, now);
						return ok({ status: RecallStatus.refused, agrees, refusals, needed });
					}
					await resolve(tx, recallId, RecallStatus.carried, now);
					const unseated = await seats.unseat(tx, realmId, subjectId, {
						actorId: voterId,
						changes: {
							by: `recall.${recall.kind === RecallKind.members ? 'members' : 'moderators'}`,
							reason: recall.reason,
							agrees,
						},
					});
					// Can't happen under the lock taken above; returned all the same, rolling back.
					if (!unseated.ok) return unseated;
					return ok({ status: RecallStatus.carried, agrees, refusals, needed });
				}
				if (cannotCarry(refusals, electorate, needed)) {
					await resolve(tx, recallId, RecallStatus.refused, now);
					return ok({ status: RecallStatus.refused, agrees, refusals, needed });
				}
				return ok({ status: RecallStatus.open, agrees, refusals, needed });
			});
		},
	};
}
