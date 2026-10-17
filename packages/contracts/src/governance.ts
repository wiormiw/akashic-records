import * as v from 'valibot';
import {
	CommentSubject,
	RealmRole,
	RecallKind,
	RecallStatus,
	TakedownStatus,
} from '@akashic/lib/enums';
import { iso, oneOf, Timestamp, trimmedAsSent, Uuid } from './common.ts';

// The governance API contract: elected moderator seats, recalls and takedowns. (Services hold a
// Temporal.Instant; the presenters render it.)

// ---- Requests --------------------------------------------------------------------------------

const reason = trimmedAsSent({ minLength: 8, maxLength: 500 });

export const VoteBody = v.object({ agree: v.boolean() });
export const ReasonBody = v.object({ reason });
export const RecallBody = v.object({ userId: Uuid, kind: oneOf(RecallKind), reason });
export const TakedownBody = v.object({ commentId: Uuid, reason });

// ---- What the services hold ------------------------------------------------------------------

/** A user named on a recall or takedown; null once their account is gone. */
export interface NamedUser {
	id: string;
	name: string;
}

/** One member's place in the race for a seat. */
export interface SeatStanding {
	userId: string;
	name: string;
	role: RealmRole;
	upvotes: number;
	seated: boolean;
	joinedAt: Temporal.Instant;
}

/** Agrees and refusals so far on one recall or takedown. */
export interface Votes {
	agrees: number;
	refusals: number;
}

/** A move to take a moderator's seat away. */
export interface Recall extends Votes {
	id: string;
	realmId: string;
	subject: NamedUser | null;
	kind: RecallKind;
	reason: string;
	proposedBy: NamedUser | null;
	status: RecallStatus;
	createdAt: Temporal.Instant;
}

/** A proposal to remove a comment. */
export interface Takedown extends Votes {
	id: string;
	realmId: string;
	subjectKind: CommentSubject;
	subjectId: string;
	reason: string;
	proposedBy: NamedUser | null;
	status: TakedownStatus;
	createdAt: Temporal.Instant;
}

/** An open takedown with the agreement it needs: the same majority its votes are tallied by. */
export interface PendingTakedown extends Takedown {
	needed: number;
}

// ---- Responses -------------------------------------------------------------------------------

const Integer = v.pipe(v.number(), v.integer());
const NamedView = v.object({ id: v.string(), name: v.string() });

const SeatStandingView = v.object({
	userId: v.string(),
	name: v.string(),
	role: oneOf(RealmRole),
	upvotes: Integer,
	seated: v.boolean(),
	joinedAt: Timestamp,
});

export const StandingsView = v.object({
	seats: Integer,
	/** Upvotes a seat needs. */
	minimum: Integer,
	members: v.array(SeatStandingView),
});

/** Who gained and who lost a seat because of this vote. */
const SeatChanges = { seated: v.array(v.string()), unseated: v.array(v.string()) };
export const UpvotedView = v.object({ upvotes: Integer, seats: Integer, ...SeatChanges });
export const UpvoteWithdrawnView = v.object({ upvotes: Integer, ...SeatChanges });
export const SeatRemovedView = v.object({ removed: v.boolean() });

export const RecallView = v.object({
	id: v.string(),
	realmId: v.string(),
	subject: v.nullable(NamedView),
	kind: oneOf(RecallKind),
	reason: v.string(),
	proposedBy: v.nullable(NamedView),
	status: oneOf(RecallStatus),
	agrees: Integer,
	refusals: Integer,
	createdAt: Timestamp,
});
export const RecallOpenedView = v.object({ id: v.string(), electorate: Integer, needed: Integer });
export const RecallTallyView = v.object({
	status: oneOf(RecallStatus),
	agrees: Integer,
	refusals: Integer,
	needed: Integer,
});

export const TakedownView = v.object({
	id: v.string(),
	realmId: v.string(),
	subjectKind: oneOf(CommentSubject),
	subjectId: v.string(),
	reason: v.string(),
	proposedBy: v.nullable(NamedView),
	status: oneOf(TakedownStatus),
	agrees: Integer,
	refusals: Integer,
	needed: Integer,
	createdAt: Timestamp,
});
export const TakedownOpenedView = v.object({
	id: v.string(),
	carried: v.boolean(),
	agrees: Integer,
	needed: Integer,
});
export const TakedownTallyView = v.object({
	status: oneOf(TakedownStatus),
	agrees: Integer,
	refusals: Integer,
	needed: Integer,
});

// ---- Presenters ------------------------------------------------------------------------------

const named = (n: NamedUser | null) => n && { id: n.id, name: n.name };

export const presentSeatStanding = (s: SeatStanding): v.InferInput<typeof SeatStandingView> => ({
	userId: s.userId,
	name: s.name,
	role: s.role,
	upvotes: s.upvotes,
	seated: s.seated,
	joinedAt: iso(s.joinedAt),
});

export const presentRecall = (r: Recall): v.InferInput<typeof RecallView> => ({
	id: r.id,
	realmId: r.realmId,
	subject: named(r.subject),
	kind: r.kind,
	reason: r.reason,
	proposedBy: named(r.proposedBy),
	status: r.status,
	agrees: r.agrees,
	refusals: r.refusals,
	createdAt: iso(r.createdAt),
});

export const presentTakedown = (d: PendingTakedown): v.InferInput<typeof TakedownView> => ({
	id: d.id,
	realmId: d.realmId,
	subjectKind: d.subjectKind,
	subjectId: d.subjectId,
	reason: d.reason,
	proposedBy: named(d.proposedBy),
	status: d.status,
	agrees: d.agrees,
	refusals: d.refusals,
	needed: d.needed,
	createdAt: iso(d.createdAt),
});
