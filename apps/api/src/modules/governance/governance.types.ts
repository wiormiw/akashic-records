import type { MiddlewareHandler } from "hono";
import type { SeatStanding } from "@akashic/contracts";
import type { Executor } from "@akashic/db";
import type { RecallKind, RecallStatus, TakedownStatus } from "@akashic/lib/enums";
import type { Clock } from "@akashic/lib/time";
import type { RealmEnv } from "@/http/realm-context.ts";
import type { createRecallService } from "./governance.recalls.service.ts";
import type { createSeatService } from "./governance.seats.service.ts";
import type { createTakedownService } from "./governance.takedowns.service.ts";

// ---- Dependencies ----------------------------------------------------------------------------

/** What the governance services are built from. */
export interface GovernanceDeps {
  db: Executor;
  clock: Clock;
}

/** Recalls unseat through the seats service, so the seats refill from the standings. */
export interface RecallDeps extends GovernanceDeps {
  seats: SeatService;
}

export type SeatService = ReturnType<typeof createSeatService>;
export type RecallService = ReturnType<typeof createRecallService>;
export type TakedownService = ReturnType<typeof createTakedownService>;

/** Every governance service, as the routes use them. */
export interface GovernanceServices {
  seats: SeatService;
  recalls: RecallService;
  takedowns: TakedownService;
}

export interface GovernanceRoutesDeps {
  governance: GovernanceServices;
  realmContext: MiddlewareHandler<RealmEnv>;
}

export type GovernanceModuleDeps = GovernanceRoutesDeps;

// ---- Realm size ------------------------------------------------------------------------------

export interface RealmSize {
  members: number;
  /** Moderators and admins: everyone who moderates. */
  moderators: number;
}

/** The counts row as the driver hands it back: counts may arrive as strings, or not at all. */
export interface SizeRow {
  members: unknown;
  moderators: unknown;
}

// ---- Seats -----------------------------------------------------------------------------------

export interface Standings {
  seats: number;
  minimum: number;
  members: SeatStanding[];
}

/** Who should hold the realm's seats, and who holds one now. */
export interface SeatCandidates {
  shouldHold: string[];
  currentlyHold: string[];
}

/** Who gained and who lost a seat because of a change. */
export interface SeatChanges {
  seated: string[];
  unseated: string[];
}

export interface Upvoted extends SeatChanges {
  upvotes: number;
  seats: number;
}

export interface UpvoteWithdrawn extends SeatChanges {
  upvotes: number;
}

export interface SeatRemoved {
  removed: boolean;
}

/** Who took a seat away and why, for the audit entry. */
export interface Unseating {
  actorId: string;
  changes: Record<string, unknown>;
}

// ---- Votes -----------------------------------------------------------------------------------

/** Where a vote stands once it is counted. */
export interface Tally<S> {
  status: S;
  agrees: number;
  refusals: number;
  needed: number;
}

export type RecallTally = Tally<RecallStatus>;
export type TakedownTally = Tally<TakedownStatus>;

export interface NewRecall {
  realmId: string;
  subjectId: string;
  kind: RecallKind;
  reason: string;
  proposedBy: string;
}

export interface RecallOpened {
  id: string;
  electorate: number;
  needed: number;
}

export interface NewTakedown {
  realmId: string;
  commentId: string;
  reason: string;
  proposedBy: string;
}

export interface TakedownOpened {
  id: string;
  carried: boolean;
  agrees: number;
  needed: number;
}
