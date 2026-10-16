import type { MiddlewareHandler } from 'hono';
import type { Authorizer } from '@akashic/authz';
import type { Executor, Tx } from '@akashic/db';
import type { CommentSubject, JobStatus, JobType, ListingStatus } from '@akashic/lib/enums';
import type {
	EventNotFound,
	MemberNotFound,
	PostingSettled,
	RealmForbidden,
	ValidationFailed,
} from '@akashic/lib/errors';
import type { Logger } from '@akashic/lib/log';
import type { Clock } from '@akashic/lib/time';
import type { RealmEnv } from '@/http/realm-context.ts';
import type { Embedder } from '@/integrations/embedder.ts';
import type { createFitService } from './postings.fit.service.ts';
import type { createInterestService } from './postings.interest.service.ts';
import type { createJobService } from './postings.jobs.service.ts';
import type { createListingService } from './postings.listings.service.ts';

// ---- Dependencies ----------------------------------------------------------------------------

/** What the postings services are built from. */
export interface PostingsDeps {
	db: Executor;
	embedder: Embedder;
	clock: Clock;
	/** For a follow-up after a posting is stored, which fails without failing the posting. */
	logger: Logger;
}

/** Interest needs the database and the time. */
export interface InterestDeps {
	db: Executor;
	clock: Clock;
}

/** The jobs and listings services also post through the fit check. */
export interface PostingAreaDeps {
	db: Executor;
	clock: Clock;
	fit: FitService;
}

export type FitService = ReturnType<typeof createFitService>;
export type InterestService = ReturnType<typeof createInterestService>;
export type JobService = ReturnType<typeof createJobService>;
export type ListingService = ReturnType<typeof createListingService>;

/** Every postings service, as the routes use them. */
export interface PostingServices {
	jobs: JobService;
	listings: ListingService;
	interest: InterestService;
	fit: FitService;
}

export interface PostingsRoutesDeps {
	postings: PostingServices;
	realmContext: MiddlewareHandler<RealmEnv>;
	authorizer: Authorizer;
}

export type PostingsModuleDeps = PostingsRoutesDeps;

// ---- Inputs ----------------------------------------------------------------------------------

/** A posting's place in the interest and review tables: which kind, which id. */
export interface Subject {
	kind: CommentSubject;
	id: string;
}

export interface NewJob {
	realmId: string;
	authorId: string;
	title: string;
	description: string;
	type: JobType;
	budgetCents?: number | undefined;
	currency: string;
	hiringFlow?: string | undefined;
}

export interface NewListing {
	realmId: string;
	sellerId: string;
	title: string;
	description: string;
	priceCents: number;
	currency: string;
	imageUrl?: string | undefined;
}

/** What the fit check reads of a posting about to be stored. */
export interface PostingDraft {
	type: 'job' | 'listing';
	kind: CommentSubject;
	realmId: string;
	authorId: string;
	title: string;
	description: string;
}

/** Writes the posting's row inside the posting's transaction and returns its id. */
export type InsertPosting = (tx: Tx) => Promise<string>;

// ---- Results ---------------------------------------------------------------------------------

export interface Posted {
	id: string;
}

export type { JobForViewer, ListingForViewer } from '@akashic/contracts';

export interface JobStatusSet {
	status: JobStatus;
}

export interface ListingStatusSet {
	status: ListingStatus;
}

export interface Hired {
	hiredUserId: string;
}

export interface Dealt {
	buyerId: string;
}

export interface Withdrawn {
	withdrawn: boolean;
}

export interface FitDecision {
	kept: boolean;
}

// ---- Realm fit -------------------------------------------------------------------------------

export type Vector = readonly number[];

/** How well a posting matches its realm, judged against the realm's centroid. */
export type Fit = 'belongs' | 'uncertain' | 'doesNotBelong';

/** A realm's centroid and how many postings taught it; null until it has learned anything. */
export interface Centroid {
	centroid: number[] | null;
	samples: number;
}

/** What to do once a posting that passed the fit check is stored. */
export type AfterStored = (id: string) => Promise<unknown>;

/** A moderator's call, as the queue row answers it. */
export interface DecidedEntry {
	subjectKind: number;
	subjectId: string;
	embedding: number[] | null;
}

// ---- Errors ----------------------------------------------------------------------------------

// What each postings service call can fail with.
export type RequireMemberError = MemberNotFound;
export type CheckFitError = ValidationFailed;
export type PostError = CheckFitError;
export type DecideFitError = EventNotFound;
export type ReadJobError = EventNotFound;
export type SetJobStatusError = EventNotFound;
export type HireError =
	| EventNotFound
	| RealmForbidden
	| PostingSettled
	| RequireMemberError
	| ValidationFailed;
export type ReadListingError = EventNotFound;
export type SetListingStatusError = RealmForbidden | EventNotFound;
export type DealError = HireError;
export type ShowInterestError = EventNotFound | RealmForbidden;
export type DropInterestError = EventNotFound;
export type ListInterestError = EventNotFound | RealmForbidden;
