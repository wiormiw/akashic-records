import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { SeatStanding } from '@akashic/contracts';
import { realmEvents } from '@akashic/contracts/events';
import {
	audit,
	type Executor,
	inTransaction,
	publish,
	realmEndorsements,
	realmMembers,
	type Tx,
	user,
} from '@akashic/db';
import { first, one } from '@akashic/db/sql';
import { AuditAction, narrow, RealmRole } from '@akashic/lib/enums';
import { NoSeatInRealm, ValidationFailed } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate } from '@akashic/lib/time';
import type {
	GovernanceDeps,
	RealmSize,
	RemoveModeratorError,
	RequireSeatHolderError,
	SeatCandidates,
	SeatChanges,
	SeatRemoved,
	Standings,
	Unseating,
	UnseatError,
	Upvoted,
	UpvoteError,
	UpvoteWithdrawn,
	WithdrawUpvoteError,
} from './governance.types.ts';

// ---- Rules -----------------------------------------------------------------------------------

/** A seat needs at least this many upvotes, so one friend can't make a moderator. */
export const MIN_UPVOTES = 3;
const MAX_SEATS = 10;
const MEMBERS_PER_SEAT = 25;

/** Moderator seats for a realm of `members`: one per 25, between 1 and 10. */
export const seats = (members: number): number =>
	Math.min(MAX_SEATS, Math.max(1, Math.ceil(members / MEMBERS_PER_SEAT)));

export const majority = (voters: number): number => Math.floor(voters / 2) + 1;

/** A vote is lost once the refusals leave too few voters to reach the threshold. */
export const cannotCarry = (refusals: number, electorate: number, needed: number): boolean =>
	refusals > electorate - needed;

// ---- Queries ---------------------------------------------------------------------------------

/** How many members the realm has, and how many of them moderate (moderators and admins). */
export async function sizeOf(db: Executor, realmId: string): Promise<RealmSize> {
	return one(
		await db
			.select({
				members: count(),
				moderators:
					sql<number>`count(*) FILTER (WHERE ${realmMembers.role} >= ${RealmRole.moderator})`.mapWith(
						Number,
					),
			})
			.from(realmMembers)
			.where(eq(realmMembers.realmId, realmId)),
		'realm size',
	);
}

/** The member's role in the realm; null when they aren't in it. */
export async function roleOf(
	db: Executor,
	realmId: string,
	userId: string,
): Promise<RealmRole | null> {
	const row = first(
		await db
			.select({ role: realmMembers.role })
			.from(realmMembers)
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId))),
	);
	return row ? narrow(RealmRole, row.role) : null;
}

const ofCandidate = (realmId: string, candidateId: string) =>
	and(eq(realmEndorsements.realmId, realmId), eq(realmEndorsements.candidateId, candidateId));

// A member's upvotes, counted by a correlated subquery; shared by standings and seat allocation.
const upvotesOf = (db: Executor) =>
	db.$count(
		realmEndorsements,
		and(
			eq(realmEndorsements.realmId, realmMembers.realmId),
			eq(realmEndorsements.candidateId, realmMembers.userId),
		),
	);

/** Members ranked by upvotes, ties broken by seniority. */
async function standingsOf(db: Executor, realmId: string, limit: number): Promise<SeatStanding[]> {
	const upvotes = upvotesOf(db).as('upvotes');
	const rows = await db
		.select({
			userId: realmMembers.userId,
			role: realmMembers.role,
			joinedAt: realmMembers.joinedAt,
			name: user.name,
			upvotes,
		})
		.from(realmMembers)
		.innerJoin(user, eq(user.id, realmMembers.userId))
		.where(eq(realmMembers.realmId, realmId))
		.orderBy(desc(upvotes), asc(realmMembers.joinedAt))
		.limit(limit);
	return rows.map((row) => ({
		userId: row.userId,
		name: row.name,
		role: narrow(RealmRole, row.role),
		upvotes: row.upvotes,
		seated: row.role === RealmRole.moderator,
		joinedAt: fromDate(row.joinedAt),
	}));
}

async function upvotesFor(db: Executor, realmId: string, candidateId: string): Promise<number> {
	return db.$count(realmEndorsements, ofCandidate(realmId, candidateId));
}

type CandidateRow = { user_id: string; should_hold: boolean; holds: boolean };

/**
 * Who should hold the realm's seats (the top `seats` by upvotes with at least `minimum`) and who
 * holds one now. Admins are never candidates.
 */
async function seatCandidates(
	db: Executor,
	realmId: string,
	seatCount: number,
	minimum: number,
): Promise<SeatCandidates> {
	// A CTE and a window function read plainer as SQL than as builder calls.
	const rows = await db.execute<CandidateRow>(sql`
    WITH ranked AS (
      SELECT m.user_id, m.role, m.joined_at,
        (SELECT count(*)::int FROM realm_endorsement e
           WHERE e.realm_id = m.realm_id AND e.candidate_id = m.user_id) AS upvotes
      FROM realm_member m
      WHERE m.realm_id = ${realmId} AND m.role <> ${RealmRole.admin}
    )
    SELECT user_id,
      (upvotes >= ${minimum}
        AND row_number() OVER (ORDER BY upvotes DESC, joined_at ASC) <= ${seatCount}) AS should_hold,
      (role = ${RealmRole.moderator}) AS holds
    FROM ranked
  `);
	return {
		shouldHold: rows.filter((row) => row.should_hold).map((row) => row.user_id),
		currentlyHold: rows.filter((row) => row.holds).map((row) => row.user_id),
	};
}

/**
 * Locks the rows of `userIds` (or, without them, every non-admin member: everyone a seat change
 * can touch). One global lock order on realm_member, by user_id, so seat changes, role changes
 * and leaving can't deadlock one another.
 */
async function lockMembers(tx: Tx, realmId: string, userIds?: readonly string[]): Promise<void> {
	if (userIds?.length === 0) return;
	await tx
		.select({ userId: realmMembers.userId })
		.from(realmMembers)
		.where(
			and(
				eq(realmMembers.realmId, realmId),
				userIds
					? inArray(realmMembers.userId, [...userIds])
					: ne(realmMembers.role, RealmRole.admin),
			),
		)
		.orderBy(asc(realmMembers.userId))
		.for('update');
}

// ---- Service ---------------------------------------------------------------------------------

export function createSeatService(deps: GovernanceDeps) {
	const { db, clock } = deps;

	/** Sets the role of each listed member; every change publishes realm.member_changed. */
	async function setRoles(
		tx: Tx,
		realmId: string,
		userIds: readonly string[],
		role: RealmRole,
	): Promise<string[]> {
		if (userIds.length === 0) return [];
		await lockMembers(tx, realmId, userIds);
		const changed = await tx
			.update(realmMembers)
			.set({ role })
			.where(and(eq(realmMembers.realmId, realmId), inArray(realmMembers.userId, [...userIds])))
			.returning({ userId: realmMembers.userId });
		const ids = changed.map((row) => row.userId);
		// Or OpenFGA drifts from Postgres.
		await publish(
			tx,
			ids.map((userId) => realmEvents.memberChanged(realmId, userId, role)),
			clock.now(),
		);
		return ids;
	}

	/** Brings seats in line with upvotes: the top candidates hold them, nobody else does. */
	async function reconcile(tx: Tx, realmId: string, size: RealmSize): Promise<SeatChanges> {
		const { shouldHold, currentlyHold } = await seatCandidates(
			tx,
			realmId,
			seats(size.members),
			MIN_UPVOTES,
		);
		const toSeat = shouldHold.filter((id) => !currentlyHold.includes(id));
		const toUnseat = currentlyHold.filter((id) => !shouldHold.includes(id));
		// Both sets at once, so the two updates below take no lock out of order.
		await lockMembers(tx, realmId, [...toSeat, ...toUnseat]);
		const seated = await setRoles(tx, realmId, toSeat, RealmRole.moderator);
		const unseated = await setRoles(tx, realmId, toUnseat, RealmRole.member);

		// An election result has no actor: the realm made it.
		const byElection = (role: RealmRole) => (userId: string) => ({
			actorId: null,
			entityType: 'realm_member',
			entityId: userId,
			action: AuditAction.roleChanged,
			changes: { realmId, role, by: 'election' },
		});
		await audit(
			tx,
			...seated.map(byElection(RealmRole.moderator)),
			...unseated.map(byElection(RealmRole.member)),
		);
		return { seated, unseated };
	}

	/**
	 * Takes a moderator's seat and their upvotes, then refills seats from the standings. Refuses
	 * when the subject has become an admin, or no longer holds a seat, since the caller checked.
	 */
	async function unseat(
		tx: Tx,
		realmId: string,
		userId: string,
		unseating: Unseating,
	): Promise<Result<void, UnseatError>> {
		const size = await sizeOf(tx, realmId);
		// Unseating then refilling touches rows in no set order, so everyone a seat change can
		// touch is locked first, in user_id order. Rare (a carried recall, an admin's removal).
		await lockMembers(tx, realmId);
		// Read again under the lock. A promotion committed since the caller's check took the row out
		// of the locked set; demoting it now would lock an admin row out of order, and demote them.
		// A demotion or a departure leaves nothing to take, and must not wipe votes or audit a change.
		const role = await roleOf(tx, realmId, userId);
		if (role === RealmRole.admin) {
			return err(new ValidationFailed('They are an admin now. An admin holds no seat to take.'));
		}
		if (role !== RealmRole.moderator) {
			return err(new NoSeatInRealm('They do not hold a seat in this realm.'));
		}
		await tx.delete(realmEndorsements).where(ofCandidate(realmId, userId));
		await setRoles(tx, realmId, [userId], RealmRole.member);
		await audit(tx, {
			actorId: unseating.actorId,
			entityType: 'realm_member',
			entityId: userId,
			action: AuditAction.roleChanged,
			changes: { realmId, role: RealmRole.member, ...unseating.changes },
		});
		await reconcile(tx, realmId, size);
		return ok(undefined);
	}

	/** Refuses anyone who holds no seat: non-members, plain members, and admins. */
	async function requireSeatHolder(
		realmId: string,
		userId: string,
		adminMessage: string,
	): Promise<Result<void, RequireSeatHolderError>> {
		const role = await roleOf(db, realmId, userId);
		if (role === null || role < RealmRole.moderator) {
			return err(new NoSeatInRealm('They do not hold a seat in this realm.'));
		}
		if (role === RealmRole.admin) {
			return err(new ValidationFailed(adminMessage));
		}
		return ok(undefined);
	}

	/**
	 * Locks every member a seat change can touch, as `unseat` does, and says whether `userId`
	 * holds a seat now. Taken before deciding to unseat, so the answer holds until the commit.
	 */
	async function lockSeatHolder(tx: Tx, realmId: string, userId: string): Promise<boolean> {
		await lockMembers(tx, realmId);
		return (await roleOf(tx, realmId, userId)) === RealmRole.moderator;
	}

	return {
		unseat,
		lockSeatHolder,
		requireSeatHolder,

		async standings(realmId: string, limit: number): Promise<Standings> {
			const [size, members] = await Promise.all([
				sizeOf(db, realmId),
				standingsOf(db, realmId, limit),
			]);
			return { seats: seats(size.members), minimum: MIN_UPVOTES, members };
		},

		async upvote(
			realmId: string,
			voterId: string,
			candidateId: string,
		): Promise<Result<Upvoted, UpvoteError>> {
			if (voterId === candidateId) {
				return err(
					new ValidationFailed(
						'You cannot upvote yourself. A seat is something the realm gives you.',
					),
				);
			}
			const role = await roleOf(db, realmId, candidateId);
			if (role === null) {
				return err(
					new NoSeatInRealm(
						'They are not a member of this realm, so there is no seat to give them.',
					),
				);
			}
			if (role === RealmRole.admin) {
				return err(
					new ValidationFailed(
						'Admins already moderate this realm. A seat would give them nothing.',
					),
				);
			}
			return inTransaction(db, async (tx) => {
				const size = await sizeOf(tx, realmId);
				await tx
					.insert(realmEndorsements)
					.values({ realmId, endorserId: voterId, candidateId })
					.onConflictDoNothing();
				const upvotes = await upvotesFor(tx, realmId, candidateId);
				return ok({ upvotes, seats: seats(size.members), ...(await reconcile(tx, realmId, size)) });
			});
		},

		withdrawUpvote(
			realmId: string,
			voterId: string,
			candidateId: string,
		): Promise<Result<UpvoteWithdrawn, WithdrawUpvoteError>> {
			return inTransaction(db, async (tx) => {
				const size = await sizeOf(tx, realmId);
				await tx
					.delete(realmEndorsements)
					.where(and(ofCandidate(realmId, candidateId), eq(realmEndorsements.endorserId, voterId)));
				const upvotes = await upvotesFor(tx, realmId, candidateId);
				return ok({ upvotes, ...(await reconcile(tx, realmId, size)) });
			});
		},

		async removeModerator(
			realmId: string,
			subjectId: string,
			actorId: string,
			reason: string,
		): Promise<Result<SeatRemoved, RemoveModeratorError>> {
			const seat = await requireSeatHolder(
				realmId,
				subjectId,
				'Change their rank instead. An admin holds no seat to take.',
			);
			if (!seat.ok) return seat;
			return inTransaction(db, async (tx) => {
				const unseated = await unseat(tx, realmId, subjectId, {
					actorId,
					changes: { by: 'admin', reason },
				});
				if (!unseated.ok) return unseated;
				return ok({ removed: true });
			});
		},
	};
}
