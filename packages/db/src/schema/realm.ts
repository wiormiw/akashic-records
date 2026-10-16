import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	doublePrecision,
	index,
	integer,
	pgTable,
	primaryKey,
	smallint,
	text,
	uniqueIndex,
	uuid,
	vector,
} from 'drizzle-orm/pg-core';
import {
	InterestStatus,
	JobStatus,
	JobType,
	ListingStatus,
	ProposalStatus,
	RealmRole,
	RecallStatus,
	RsvpStatus,
	TakedownStatus,
} from '@akashic/lib/enums';
import { user } from './auth.ts';
import { cascadeTo, citext, createdAt, primaryId, updatedAt, utcTimestamp } from './columns.ts';

// Width of the embedding vectors; must equal what the embedder adapter requests from the model
// (centroid and listing embedding columns below).
const EMBEDDING_DIMENSIONS = 1536;

export const realms = pgTable(
	'realm',
	{
		id: primaryId(),
		slug: citext('slug').notNull(),
		name: text('name').notNull(),
		description: text('description'),
		category: text('category'),
		createdBy: uuid('created_by')
			.notNull()
			.references(() => user.id),
		// The mean embedding of what the realm is about; postings far from it go to the fit queue.
		centroid: vector('centroid', { dimensions: EMBEDDING_DIMENSIONS }),
		centroidSamples: integer('centroid_samples').notNull().default(0),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		// Archived realms stay readable; nothing new can be posted.
		archivedAt: utcTimestamp('archived_at'),
	},
	(table) => [uniqueIndex('ux_realm_slug').on(table.slug)],
);

export const realmMembers = pgTable(
	'realm_member',
	{
		realmId: cascadeTo('realm_id', () => realms.id),
		userId: cascadeTo('user_id', () => user.id),
		role: smallint('role').notNull().default(RealmRole.member),
		displayName: text('display_name'),
		joinedAt: utcTimestamp('joined_at').notNull().defaultNow(),
	},
	(table) => [
		primaryKey({ columns: [table.realmId, table.userId] }),
		index('ix_realm_member_role').on(table.realmId, table.role),
		index('ix_realm_member_user').on(table.userId),
	],
);

export const realmModules = pgTable(
	'realm_module',
	{
		realmId: cascadeTo('realm_id', () => realms.id),
		module: smallint('module').notNull(),
		enabledAt: utcTimestamp('enabled_at').notNull().defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.realmId, table.module] })],
);

/** How an event or a job opens: which realm, who posted it, and what it says. */
const postingColumns = () => ({
	id: primaryId(),
	realmId: cascadeTo('realm_id', () => realms.id),
	authorId: cascadeTo('author_id', () => user.id),
	title: text('title').notNull(),
	description: text('description').notNull(),
});

export const events = pgTable(
	'event',
	{
		...postingColumns(),
		startsAt: utcTimestamp('starts_at').notNull(),
		endsAt: utcTimestamp('ends_at'),
		location: text('location'),
		imageUrl: text('image_url'),
		// Null means unlimited.
		capacity: integer('capacity'),
		commentsEnabled: boolean('comments_enabled').notNull().default(true),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index('ix_event_realm_start').on(table.realmId, table.startsAt)],
);

export const eventRsvps = pgTable(
	'event_rsvp',
	{
		eventId: cascadeTo('event_id', () => events.id),
		userId: cascadeTo('user_id', () => user.id),
		status: smallint('status').notNull().default(RsvpStatus.going),
		respondedAt: utcTimestamp('responded_at').notNull().defaultNow(),
	},
	(table) => [
		primaryKey({ columns: [table.eventId, table.userId] }),
		index('ix_event_rsvp_status').on(table.eventId, table.status),
	],
);

export const jobs = pgTable(
	'job',
	{
		...postingColumns(),
		type: smallint('type').notNull().default(JobType.commission),
		budgetCents: bigint('budget_cents', { mode: 'number' }),
		currency: text('currency').notNull().default('IDR'),
		status: smallint('status').notNull().default(JobStatus.open),
		hiringFlow: text('hiring_flow'),
		hiredUserId: uuid('hired_user_id').references(() => user.id, { onDelete: 'set null' }),
		hiredAt: utcTimestamp('hired_at'),
		commentsEnabled: boolean('comments_enabled').notNull().default(true),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index('ix_job_realm_status').on(table.realmId, table.status, table.createdAt)],
);

export const listings = pgTable(
	'listing',
	{
		id: primaryId(),
		realmId: cascadeTo('realm_id', () => realms.id),
		sellerId: cascadeTo('seller_id', () => user.id),
		title: text('title').notNull(),
		description: text('description').notNull(),
		priceCents: bigint('price_cents', { mode: 'number' }).notNull(),
		currency: text('currency').notNull().default('IDR'),
		imageUrl: text('image_url'),
		status: smallint('status').notNull().default(ListingStatus.active),
		buyerId: uuid('buyer_id').references(() => user.id, { onDelete: 'set null' }),
		soldAt: utcTimestamp('sold_at'),
		commentsEnabled: boolean('comments_enabled').notNull().default(true),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [index('ix_listing_realm_status').on(table.realmId, table.status, table.createdAt)],
);

export const comments = pgTable(
	'comment',
	{
		id: primaryId(),
		realmId: cascadeTo('realm_id', () => realms.id),
		subjectKind: smallint('subject_kind').notNull(),
		// Polymorphic: an event, listing or job id depending on subject_kind, so no foreign key.
		subjectId: uuid('subject_id').notNull(),
		authorId: cascadeTo('author_id', () => user.id),
		body: text('body').notNull(),
		// Soft delete: a removed comment keeps its place in the thread.
		removedAt: utcTimestamp('removed_at'),
		createdAt: createdAt(),
	},
	(table) => [index('ix_comment_subject').on(table.subjectKind, table.subjectId, table.createdAt)],
);

/** Postings that sit far from their realm's centroid, waiting for a moderator's call. */
export const realmFitQueue = pgTable(
	'realm_fit_queue',
	{
		id: primaryId(),
		realmId: cascadeTo('realm_id', () => realms.id),
		subjectKind: smallint('subject_kind').notNull(),
		subjectId: uuid('subject_id').notNull(),
		distance: doublePrecision('distance').notNull(),
		embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
		keptBy: uuid('kept_by').references(() => user.id),
		// Null until decided.
		kept: boolean('kept'),
		decidedAt: utcTimestamp('decided_at'),
		createdAt: createdAt(),
	},
	(table) => [
		index('ix_fit_queue_pending').on(table.realmId, table.kept, table.createdAt),
		uniqueIndex('ux_fit_queue_subject').on(table.subjectKind, table.subjectId),
	],
);

export const postingInterests = pgTable(
	'posting_interest',
	{
		id: primaryId(),
		realmId: cascadeTo('realm_id', () => realms.id),
		subjectKind: smallint('subject_kind').notNull(),
		subjectId: uuid('subject_id').notNull(),
		userId: cascadeTo('user_id', () => user.id),
		note: text('note'),
		status: smallint('status').notNull().default(InterestStatus.open),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex('ux_posting_interest_once').on(table.subjectKind, table.subjectId, table.userId),
		index('ix_posting_interest_subject').on(table.subjectKind, table.subjectId, table.status),
	],
);

export const realmProposals = pgTable(
	'realm_proposal',
	{
		id: primaryId(),
		slug: citext('slug').notNull(),
		name: text('name').notNull(),
		description: text('description'),
		category: text('category'),
		modules: smallint('modules').array().notNull().default([]),
		rationale: text('rationale').notNull(),
		proposedBy: cascadeTo('proposed_by', () => user.id),
		status: smallint('status').notNull().default(ProposalStatus.pending),
		decidedBy: uuid('decided_by').references(() => user.id, { onDelete: 'set null' }),
		decidedAt: utcTimestamp('decided_at'),
		decisionNote: text('decision_note'),
		realmId: uuid('realm_id').references(() => realms.id, { onDelete: 'set null' }),
		createdAt: createdAt(),
	},
	(table) => [
		index('ix_proposal_pending').on(table.status, table.createdAt),
		index('ix_proposal_by_user').on(table.proposedBy, table.createdAt),
	],
);

/** A verified member vouching for a candidate; enough of them promotes the candidate. */
export const realmEndorsements = pgTable(
	'realm_endorsement',
	{
		realmId: cascadeTo('realm_id', () => realms.id),
		endorserId: cascadeTo('endorser_id', () => user.id),
		candidateId: cascadeTo('candidate_id', () => user.id),
		createdAt: createdAt(),
	},
	(table) => [
		primaryKey({ columns: [table.realmId, table.endorserId, table.candidateId] }),
		index('ix_endorsement_candidate').on(table.realmId, table.candidateId),
	],
);

export const takedowns = pgTable(
	'takedown',
	{
		id: primaryId(),
		realmId: cascadeTo('realm_id', () => realms.id),
		subjectKind: smallint('subject_kind').notNull().default(0),
		subjectId: uuid('subject_id').notNull(),
		reason: text('reason').notNull(),
		proposedBy: cascadeTo('proposed_by', () => user.id),
		status: smallint('status').notNull().default(TakedownStatus.open),
		resolvedAt: utcTimestamp('resolved_at'),
		createdAt: createdAt(),
	},
	(table) => [
		// One open takedown per posting.
		uniqueIndex('ux_takedown_open')
			.on(table.realmId, table.subjectKind, table.subjectId)
			.where(sql`status = 0`),
		index('ix_takedown_open').on(table.realmId, table.status, table.createdAt),
	],
);

export const takedownVotes = pgTable(
	'takedown_vote',
	{
		takedownId: cascadeTo('takedown_id', () => takedowns.id),
		voterId: cascadeTo('voter_id', () => user.id),
		agree: boolean('agree').notNull(),
		createdAt: createdAt(),
	},
	(table) => [primaryKey({ columns: [table.takedownId, table.voterId] })],
);

export const recalls = pgTable(
	'recall',
	{
		id: primaryId(),
		realmId: cascadeTo('realm_id', () => realms.id),
		// The member whose rank is being recalled.
		subjectId: cascadeTo('subject_id', () => user.id),
		kind: smallint('kind').notNull(),
		reason: text('reason').notNull(),
		proposedBy: cascadeTo('proposed_by', () => user.id),
		status: smallint('status').notNull().default(RecallStatus.open),
		resolvedAt: utcTimestamp('resolved_at'),
		createdAt: createdAt(),
	},
	(table) => [
		uniqueIndex('ux_recall_open')
			.on(table.realmId, table.subjectId)
			.where(sql`status = 0`),
		index('ix_recall_open').on(table.realmId, table.status, table.createdAt),
	],
);

export const recallVotes = pgTable(
	'recall_vote',
	{
		recallId: cascadeTo('recall_id', () => recalls.id),
		voterId: cascadeTo('voter_id', () => user.id),
		agree: boolean('agree').notNull(),
		createdAt: createdAt(),
	},
	(table) => [primaryKey({ columns: [table.recallId, table.voterId] })],
);
