import type { MiddlewareHandler } from 'hono';
import type { Authorizer } from '@akashic/authz';
import type { Executor } from '@akashic/db';
import type { RealmRole } from '@akashic/lib/enums';
import type {
	AlreadyMember,
	DuplicateSlug,
	MemberNotFound,
	RealmForbidden,
	RealmNotFound,
	SoleAdmin,
} from '@akashic/lib/errors';
import type { Logger } from '@akashic/lib/log';
import type { Clock } from '@akashic/lib/time';
import type { RealmEnv } from '@/http/realm-context.ts';
import type { Sessions } from '@/http/session.ts';
import type { Embedder } from '@/integrations/embedder.ts';
import type { RealmService } from './realm.service.ts';

export interface RealmDeps {
	db: Executor;
	embedder: Embedder;
	clock: Clock;
}

/** What the proposals half of the realm service is built from. */
export interface ProposalDeps {
	db: Executor;
	clock: Clock;
	seedCentroid: (realmId: string, name: string, description: string | null) => Promise<boolean>;
}

/** The facts that found a realm, whether directly or by approving a proposal. */
export interface FoundRealm {
	slug: string;
	name: string;
	description?: string | null | undefined;
	category?: string | null | undefined;
	modules: readonly number[];
}

/** A founded realm's identity. */
export interface FoundedRealm {
	id: string;
	slug: string;
}

export interface NewProposal {
	slug: string;
	name: string;
	description?: string | undefined;
	category?: string | undefined;
	modules: readonly number[];
	rationale: string;
	proposedBy: string;
}

/** One proposal row, joined to its proposer (`proposed_by` cascades, so there always is one). */
export interface ProposalRow {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	category: string | null;
	modules: number[];
	rationale: string;
	status: number;
	decisionNote: string | null;
	decidedAt: Date | null;
	realmId: string | null;
	createdAt: Date;
	proposerId: string;
	proposerName: string;
	proposerEmail: string;
}

/** A proposal's id. */
export interface ProposalRef {
	id: string;
}

/** The realm an approval founded. */
export interface ApprovedRealm {
	realmId: string;
}

/**
 * Who acts on a membership, and whether they hold platform authority, which outranks every realm
 * role. Their realm role isn't carried: the service reads it under the row lock.
 */
export interface Actor {
	id: string;
	platform: boolean;
}

export interface Joined {
	joined: true;
}

export interface Left {
	left: true;
}

export interface RoleChange {
	userId: string;
	role: RealmRole;
}

/** The names of the fields an edit changed. */
export interface Edited {
	changed: string[];
}

export interface Archived {
	archived: boolean;
}

// What each realm service call can fail with.
export type ReadRealmError = RealmNotFound;
export type FoundRealmError = DuplicateSlug;
export type JoinError = AlreadyMember;
export type LeaveError = SoleAdmin | MemberNotFound;
export type ChangeRoleError = RealmForbidden | MemberNotFound | SoleAdmin;
export type EditRealmError = RealmNotFound;
export type ArchiveRealmError = RealmNotFound;
// Proposals reuse realm.duplicate_slug for any refusal to file or decide one: the code is on the wire.
export type ProposeError = DuplicateSlug;
export type ApproveError = RealmNotFound | FoundRealmError;
export type RejectError = RealmNotFound;

/** What the realm routes are built from. */
export interface RealmRoutesDeps {
	realms: RealmService;
	sessions: Sessions;
	realmContext: MiddlewareHandler<RealmEnv>;
}

/** What keeps OpenFGA in step with membership: the current role is read from Postgres. */
export interface RealmConsumerDeps {
	realms: Pick<RealmService, 'memberRole'>;
	authorizer: Authorizer;
	logger: Logger;
}

/** The routes' needs plus the consumer's. */
export interface RealmModuleDeps extends RealmRoutesDeps, Omit<RealmConsumerDeps, 'realms'> {}
