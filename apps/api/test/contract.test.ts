// The real protection is the presenters typed InferInput<View>, the route tests parsing with the
// views, svelte-check and the coverage guard. The JSON round trip only catches non-JSON values.
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import * as contracts from '@akashic/contracts';
import {
	AuditAction,
	CommentSubject,
	InterestStatus,
	JobStatus,
	JobType,
	ListingStatus,
	ProposalStatus,
	RealmModule,
	RealmRole,
	RecallKind,
	RecallStatus,
	RoomSubject,
	RsvpStatus,
	TakedownStatus,
} from '@akashic/lib/enums';

// Every response view in @akashic/contracts. The web app parses responses with these same views,
// so one sample per view is enough: built by the view's presenter (or by hand where there is
// none), parsed, serialised as the wire would, and parsed again. Both parses must accept it.

const at = Temporal.Instant.from('2026-06-01T12:00:00Z');
const later = Temporal.Instant.from('2026-06-02T12:00:00Z');
const id = '0197a4a0-0000-7000-8000-000000000001';
const other = '0197a4a0-0000-7000-8000-000000000002';
const person = { id, name: 'Ada', email: 'ada@example.test' };
const named = { id, name: 'Ada' };

interface Pair {
	view: v.GenericSchema;
	/** What the route sends before the view parses it. */
	sample: unknown;
}

// Keyed by the export's name in @akashic/contracts. `Created` is not a *View but is a response.
const pairs: Record<string, Pair> = {
	MailStatusView: {
		view: contracts.MailStatusView,
		sample: { configured: true, healthy: false, lastFailure: 'boom', failedAt: null },
	},

	// admin
	CountsView: {
		view: contracts.CountsView,
		sample: contracts.presentCounts({
			realms: 3,
			archived: 1,
			orphaned: 1,
			members: 9,
			openReports: 2,
			auditEntries: 40,
		}),
	},
	PlatformRealmView: {
		view: contracts.PlatformRealmView,
		sample: contracts.presentPlatformRealm({
			id,
			slug: 'weaboo',
			name: 'Weaboo',
			category: null,
			memberCount: 4,
			adminCount: 1,
			archivedAt: later,
			createdAt: at,
			createdBy: person,
		}),
	},
	AuditView: {
		view: contracts.AuditView,
		sample: contracts.presentAudit({
			id,
			actor: person,
			entityType: 'realm',
			entityId: other,
			action: AuditAction.roleChanged,
			changes: { role: 2 },
			traceId: null,
			occurredAt: at,
		}),
	},
	ReportView: {
		view: contracts.ReportView,
		sample: contracts.presentReport({
			id,
			roomId: other,
			messageId: null,
			reason: 'threats',
			disclosedText: null,
			reporter: person,
			accused: null,
			senderMatches: null,
			reviewedAt: null,
			createdAt: at,
		}),
	},
	AccountView: {
		view: contracts.AccountView,
		sample: contracts.presentAccount({
			id,
			name: 'Ada',
			email: 'ada@example.test',
			emailVerified: true,
			createdAt: at,
			bannedAt: at,
			banReason: 'spam',
			bannedUntil: null,
			realmCount: 2,
		}),
	},

	// comments
	CommentView: {
		view: contracts.CommentView,
		sample: contracts.presentComment({
			id,
			body: '',
			authorId: other,
			authorName: 'Ada',
			authorImage: null,
			removed: true,
			createdAt: at,
		}),
	},

	// events
	EventSummaryView: {
		view: contracts.EventSummaryView,
		sample: contracts.presentEventSummary({
			id,
			title: 'Meetup',
			startsAt: at,
			capacity: null,
			imageUrl: null,
			goingCount: 3,
		}),
	},
	EventView: {
		view: contracts.EventView,
		sample: contracts.presentEvent({
			id,
			title: 'Meetup',
			startsAt: at,
			capacity: 20,
			imageUrl: 'https://example.test/a.png',
			goingCount: 3,
			description: 'Come along',
			endsAt: later,
			location: 'Hall',
			authorId: other,
			authorName: 'Ada',
			commentsEnabled: true,
			yourRsvp: RsvpStatus.interested,
		}),
	},

	// governance
	StandingsView: {
		view: contracts.StandingsView,
		sample: {
			seats: 2,
			minimum: 3,
			members: [
				contracts.presentSeatStanding({
					userId: id,
					name: 'Ada',
					role: RealmRole.moderator,
					upvotes: 5,
					seated: true,
					joinedAt: at,
				}),
			],
		},
	},
	RecallView: {
		view: contracts.RecallView,
		sample: contracts.presentRecall({
			id,
			realmId: other,
			subject: named,
			kind: RecallKind.moderators,
			reason: 'abuse of power',
			proposedBy: null,
			status: RecallStatus.open,
			agrees: 1,
			refusals: 0,
			createdAt: at,
		}),
	},
	TakedownView: {
		view: contracts.TakedownView,
		sample: contracts.presentTakedown({
			id,
			realmId: other,
			subjectKind: CommentSubject.listing,
			subjectId: other,
			reason: 'not allowed here',
			proposedBy: named,
			status: TakedownStatus.open,
			agrees: 1,
			refusals: 0,
			needed: 2,
			createdAt: at,
		}),
	},

	// postings
	JobSummaryView: {
		view: contracts.JobSummaryView,
		sample: contracts.presentJobSummary({
			id,
			title: 'Logo',
			type: JobType.freelance,
			budgetCents: null,
			currency: 'USD',
			status: JobStatus.open,
			createdAt: at,
		}),
	},
	JobView: {
		view: contracts.JobView,
		sample: contracts.presentJob({
			id,
			title: 'Logo',
			type: JobType.commission,
			budgetCents: 5000,
			currency: 'USD',
			status: JobStatus.filled,
			createdAt: at,
			description: 'A logo',
			hiringFlow: null,
			hiredUserId: other,
			commentsEnabled: true,
			authorId: other,
			authorName: 'Ada',
			viewerInterested: true,
		}),
	},
	ListingSummaryView: {
		view: contracts.ListingSummaryView,
		sample: contracts.presentListingSummary({
			id,
			title: 'Card',
			priceCents: 100,
			currency: 'USD',
			status: ListingStatus.active,
			imageUrl: null,
			createdAt: at,
		}),
	},
	ListingView: {
		view: contracts.ListingView,
		sample: contracts.presentListing({
			id,
			title: 'Card',
			priceCents: 100,
			currency: 'USD',
			status: ListingStatus.sold,
			imageUrl: 'https://example.test/a.png',
			createdAt: at,
			description: 'Rare',
			buyerId: other,
			commentsEnabled: false,
			sellerId: other,
			sellerName: 'Ada',
			viewerInterested: false,
		}),
	},
	InterestView: {
		view: contracts.InterestView,
		sample: contracts.presentInterest({
			id,
			userId: other,
			userName: 'Ada',
			note: null,
			status: InterestStatus.accepted,
			createdAt: at,
		}),
	},
	FitReviewView: {
		view: contracts.FitReviewView,
		sample: contracts.presentFitReview({
			id,
			subjectKind: CommentSubject.job,
			subjectId: other,
			distance: 0.42,
			createdAt: at,
		}),
	},

	// realms
	RealmSummaryView: {
		view: contracts.RealmSummaryView,
		sample: contracts.presentRealmSummary({
			id,
			slug: 'weaboo',
			name: 'Weaboo',
			description: null,
			category: 'anime',
			memberCount: 4,
			modules: [RealmModule.jobs, RealmModule.election],
		}),
	},
	FoundedView: {
		view: contracts.FoundedView,
		sample: { id, slug: 'weaboo' },
	},
	StandingView: {
		view: contracts.StandingView,
		sample: contracts.presentStanding(RealmRole.moderator, {
			post: true,
			postJob: true,
			postEvent: false,
			participate: true,
			moderate: true,
			vouch: false,
			administer: false,
		}),
	},
	MemberView: {
		view: contracts.MemberView,
		sample: contracts.presentMember({
			userId: id,
			role: RealmRole.admin,
			displayName: null,
			name: 'Ada',
			image: null,
			joinedAt: at,
		}),
	},
	ProposalView: {
		view: contracts.ProposalView,
		sample: contracts.presentProposal({
			id,
			slug: 'weaboo',
			name: 'Weaboo',
			description: null,
			category: null,
			modules: [RealmModule.events],
			rationale: 'x'.repeat(40),
			proposedBy: person,
			status: ProposalStatus.approved,
			decisionNote: null,
			decidedAt: later,
			realmId: other,
			createdAt: at,
		}),
	},

	// rooms
	DeviceKeyView: {
		view: contracts.DeviceKeyView,
		sample: contracts.presentDeviceKey({
			userId: id,
			publicKey: 'p'.repeat(32),
			signingKey: null,
			fingerprint: 'f'.repeat(8),
		}),
	},
	RoomSummaryView: {
		view: contracts.RoomSummaryView,
		sample: contracts.presentRoomSummary({
			id,
			realmId: other,
			subjectKind: RoomSubject.listing,
			subjectId: other,
			otherId: other,
			otherName: 'Ada',
			lastMessageAt: null,
			createdAt: at,
		}),
	},
	MessageView: {
		view: contracts.MessageView,
		sample: contracts.presentMessage({
			id,
			senderId: other,
			body: 'sealed',
			iv: 'iv',
			signature: null,
			createdAt: at,
			wrappedKey: 'wrapped',
			keyIv: 'keyiv',
		}),
	},
	TicketView: {
		view: contracts.TicketView,
		sample: { ticket: 't', expiresInSeconds: 30 },
	},
	// The live frame carries a message plus `keys`.
	MessageFrameView: {
		view: contracts.MessageFrameView,
		sample: contracts.presentMessageFrame({
			id,
			senderId: other,
			body: 'sealed',
			iv: 'iv',
			keys: [{ fingerprint: 'f'.repeat(8), wrappedKey: 'w'.repeat(16), iv: 'iv' }],
			createdAt: at,
		}),
	},

	// uploads
	LimitsView: {
		view: contracts.LimitsView,
		sample: { enabled: true, imageTypes: ['image/png'], maxBytes: 1_000_000 },
	},
	UploadedView: { view: contracts.UploadedView, sample: { url: 'https://x' } },

	// Small write acknowledgements and socket frames, by hand: they have no presenter.
	GrantedView: { view: contracts.GrantedView, sample: { realmId: id, userId: other, name: 'Ada' } },
	BanView: { view: contracts.BanView, sample: { banned: true } },
	ReviewedView: { view: contracts.ReviewedView, sample: { id } },
	RemovedView: { view: contracts.RemovedView, sample: { removed: true } },
	RsvpView: { view: contracts.RsvpView, sample: { status: RsvpStatus.going } },
	ClearedView: { view: contracts.ClearedView, sample: { cleared: true } },
	UpvotedView: {
		view: contracts.UpvotedView,
		sample: { upvotes: 3, seats: 2, seated: [id], unseated: [other] },
	},
	UpvoteWithdrawnView: {
		view: contracts.UpvoteWithdrawnView,
		sample: { upvotes: 2, seated: [], unseated: [other] },
	},
	SeatRemovedView: { view: contracts.SeatRemovedView, sample: { removed: true } },
	RecallOpenedView: {
		view: contracts.RecallOpenedView,
		sample: { id, electorate: 10, needed: 6 },
	},
	RecallTallyView: {
		view: contracts.RecallTallyView,
		sample: { status: RecallStatus.open, agrees: 1, refusals: 0, needed: 6 },
	},
	TakedownOpenedView: {
		view: contracts.TakedownOpenedView,
		sample: { id, carried: false, agrees: 1, needed: 2 },
	},
	TakedownTallyView: {
		view: contracts.TakedownTallyView,
		sample: { status: TakedownStatus.open, agrees: 1, refusals: 0, needed: 2 },
	},
	JobStatusView: { view: contracts.JobStatusView, sample: { status: JobStatus.closed } },
	ListingStatusView: {
		view: contracts.ListingStatusView,
		sample: { status: ListingStatus.removed },
	},
	HiredView: { view: contracts.HiredView, sample: { hiredUserId: other } },
	DealtView: { view: contracts.DealtView, sample: { buyerId: other } },
	WithdrawnView: { view: contracts.WithdrawnView, sample: { withdrawn: true } },
	FitDecisionView: { view: contracts.FitDecisionView, sample: { kept: false } },
	JoinedView: { view: contracts.JoinedView, sample: { joined: true } },
	LeftView: { view: contracts.LeftView, sample: { left: true } },
	EditedView: { view: contracts.EditedView, sample: { changed: ['name', 'description'] } },
	ArchivedView: { view: contracts.ArchivedView, sample: { archived: true } },
	RoleChangedView: {
		view: contracts.RoleChangedView,
		sample: { userId: id, role: RealmRole.moderator },
	},
	ApprovedView: { view: contracts.ApprovedView, sample: { realmId: other } },
	RejectedView: { view: contracts.RejectedView, sample: { id } },
	PublishedView: { view: contracts.PublishedView, sample: { published: true } },
	BlockedView: { view: contracts.BlockedView, sample: { blocked: true } },
	RetentionView: { view: contracts.RetentionView, sample: { days: null, inForce: false } },
	StaleDevicesFrameView: {
		view: contracts.StaleDevicesFrameView,
		sample: { type: 'stale_devices', devices: ['f'.repeat(8)] },
	},
	ErrorFrameView: {
		view: contracts.ErrorFrameView,
		sample: { type: 'error', detail: 'unreadable frame' },
	},

	// common
	Created: { view: contracts.Created, sample: { id } },
};

describe('every response view survives the wire', () => {
	for (const [name, pair] of Object.entries(pairs)) {
		test(name, () => {
			const output = v.parse(pair.view, pair.sample);
			// What the client receives is the JSON text of the view's output; the web app parses
			// that same text with the same view.
			const wire: unknown = JSON.parse(JSON.stringify(output));
			expect(v.safeParse(pair.view, wire).issues).toBeUndefined();
			expect(wire).toEqual(output);
		});
	}

	test('every exported view has a sample', () => {
		const views = Object.keys(contracts).filter((key) => key.endsWith('View'));
		expect(views.filter((view) => !(view in pairs))).toEqual([]);
		// A stale entry would hide a view that was renamed or removed.
		expect(Object.keys(pairs).filter((key) => key !== 'Created' && !views.includes(key))).toEqual(
			[],
		);
	});
});
