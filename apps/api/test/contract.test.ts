import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import * as contracts from "@akashic/contracts";
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
} from "@akashic/lib/enums";
import { Web } from "./fixtures/web-schemas.ts";

// Every response view in @akashic/contracts against the schema the web app parses it with. The
// value is built by the view's presenter (or by hand where there is none), parsed by the view,
// serialised as the wire would, and parsed again by the web app's schema. Both must accept it.

const at = Temporal.Instant.from("2026-06-01T12:00:00Z");
const later = Temporal.Instant.from("2026-06-02T12:00:00Z");
const id = "0197a4a0-0000-7000-8000-000000000001";
const other = "0197a4a0-0000-7000-8000-000000000002";
const person = { id, name: "Ada", email: "ada@example.test" };
const named = { id, name: "Ada" };

interface Pair {
  view: v.GenericSchema;
  web: v.GenericSchema;
  /** What the route sends before the view parses it. */
  sample: unknown;
}

// Keyed by the export's name in @akashic/contracts. `Created` is not a *View but is a response.
const pairs: Record<string, Pair> = {
  MailStatusView: {
    view: contracts.MailStatusView,
    web: Web.MailStatus,
    sample: { configured: true, healthy: false, lastFailure: "boom", failedAt: null },
  },

  // admin
  CountsView: {
    view: contracts.CountsView,
    web: Web.Overview,
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
    web: Web.PlatformRealm,
    sample: contracts.presentPlatformRealm({
      id,
      slug: "weaboo",
      name: "Weaboo",
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
    web: Web.AuditEntry,
    sample: contracts.presentAudit({
      id,
      actor: person,
      entityType: "realm",
      entityId: other,
      action: AuditAction.roleChanged,
      changes: { role: 2 },
      traceId: null,
      occurredAt: at,
    }),
  },
  ReportView: {
    view: contracts.ReportView,
    web: Web.Report,
    sample: contracts.presentReport({
      id,
      roomId: other,
      messageId: null,
      reason: "threats",
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
    web: Web.PlatformAccount,
    sample: contracts.presentAccount({
      id,
      name: "Ada",
      email: "ada@example.test",
      emailVerified: true,
      createdAt: at,
      bannedAt: at,
      banReason: "spam",
      bannedUntil: null,
      realmCount: 2,
    }),
  },

  // comments
  CommentView: {
    view: contracts.CommentView,
    web: Web.Comment,
    sample: contracts.presentComment({
      id,
      body: "",
      authorId: other,
      authorName: "Ada",
      authorImage: null,
      removed: true,
      createdAt: at,
    }),
  },

  // events
  EventSummaryView: {
    view: contracts.EventSummaryView,
    web: Web.EventTeaser,
    sample: contracts.presentEventSummary({
      id,
      title: "Meetup",
      startsAt: at,
      capacity: null,
      imageUrl: null,
      goingCount: 3,
    }),
  },
  EventView: {
    view: contracts.EventView,
    web: Web.EventDetail,
    sample: contracts.presentEvent({
      id,
      title: "Meetup",
      startsAt: at,
      capacity: 20,
      imageUrl: "https://example.test/a.png",
      goingCount: 3,
      description: "Come along",
      endsAt: later,
      location: "Hall",
      authorId: other,
      authorName: "Ada",
      commentsEnabled: true,
      yourRsvp: RsvpStatus.interested,
    }),
  },

  // governance
  StandingsView: {
    view: contracts.StandingsView,
    web: Web.Standings,
    sample: {
      seats: 2,
      minimum: 3,
      members: [
        contracts.presentSeatStanding({
          userId: id,
          name: "Ada",
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
    web: Web.Recall,
    sample: contracts.presentRecall({
      id,
      realmId: other,
      subject: named,
      kind: RecallKind.moderators,
      reason: "abuse of power",
      proposedBy: null,
      status: RecallStatus.open,
      agrees: 1,
      refusals: 0,
      createdAt: at,
    }),
  },
  TakedownView: {
    view: contracts.TakedownView,
    web: Web.Takedown,
    sample: contracts.presentTakedown({
      id,
      realmId: other,
      subjectKind: CommentSubject.listing,
      subjectId: other,
      reason: "not allowed here",
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
    web: Web.JobTeaser,
    sample: contracts.presentJobSummary({
      id,
      title: "Logo",
      type: JobType.freelance,
      budgetCents: null,
      currency: "USD",
      status: JobStatus.open,
      createdAt: at,
    }),
  },
  JobView: {
    view: contracts.JobView,
    web: Web.JobDetail,
    sample: contracts.presentJob({
      id,
      title: "Logo",
      type: JobType.commission,
      budgetCents: 5000,
      currency: "USD",
      status: JobStatus.filled,
      createdAt: at,
      description: "A logo",
      hiringFlow: null,
      hiredUserId: other,
      commentsEnabled: true,
      authorId: other,
      authorName: "Ada",
      viewerInterested: true,
    }),
  },
  ListingSummaryView: {
    view: contracts.ListingSummaryView,
    web: Web.ListingTeaser,
    sample: contracts.presentListingSummary({
      id,
      title: "Card",
      priceCents: 100,
      currency: "USD",
      status: ListingStatus.active,
      imageUrl: null,
      createdAt: at,
    }),
  },
  ListingView: {
    view: contracts.ListingView,
    web: Web.ListingDetail,
    sample: contracts.presentListing({
      id,
      title: "Card",
      priceCents: 100,
      currency: "USD",
      status: ListingStatus.sold,
      imageUrl: "https://example.test/a.png",
      createdAt: at,
      description: "Rare",
      buyerId: other,
      commentsEnabled: false,
      sellerId: other,
      sellerName: "Ada",
      viewerInterested: false,
    }),
  },
  InterestView: {
    view: contracts.InterestView,
    web: Web.Interest,
    sample: contracts.presentInterest({
      id,
      userId: other,
      userName: "Ada",
      note: null,
      status: InterestStatus.accepted,
      createdAt: at,
    }),
  },
  FitReviewView: {
    view: contracts.FitReviewView,
    web: Web.Review,
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
    web: Web.RealmSummary,
    sample: contracts.presentRealmSummary({
      id,
      slug: "weaboo",
      name: "Weaboo",
      description: null,
      category: "anime",
      memberCount: 4,
      modules: [RealmModule.jobs, RealmModule.election],
    }),
  },
  FoundedView: {
    view: contracts.FoundedView,
    web: Web.Founded,
    sample: { id, slug: "weaboo" },
  },
  StandingView: {
    view: contracts.StandingView,
    web: Web.Standing,
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
    web: Web.Member,
    sample: contracts.presentMember({
      userId: id,
      role: RealmRole.admin,
      displayName: null,
      name: "Ada",
      image: null,
      joinedAt: at,
    }),
  },
  ProposalView: {
    view: contracts.ProposalView,
    web: Web.Proposal,
    sample: contracts.presentProposal({
      id,
      slug: "weaboo",
      name: "Weaboo",
      description: null,
      category: null,
      modules: [RealmModule.events],
      rationale: "x".repeat(40),
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
    web: Web.PublicKeys,
    sample: contracts.presentDeviceKey({
      userId: id,
      publicKey: "p".repeat(32),
      signingKey: null,
      fingerprint: "f".repeat(8),
    }),
  },
  RoomSummaryView: {
    view: contracts.RoomSummaryView,
    web: Web.RoomSummary,
    sample: contracts.presentRoomSummary({
      id,
      realmId: other,
      subjectKind: RoomSubject.listing,
      subjectId: other,
      otherId: other,
      otherName: "Ada",
      lastMessageAt: null,
      createdAt: at,
    }),
  },
  MessageView: {
    view: contracts.MessageView,
    web: Web.StoredMessage,
    sample: contracts.presentMessage({
      id,
      senderId: other,
      body: "sealed",
      iv: "iv",
      signature: null,
      createdAt: at,
      wrappedKey: "wrapped",
      keyIv: "keyiv",
    }),
  },
  TicketView: {
    view: contracts.TicketView,
    web: Web.Ticket,
    sample: { ticket: "t", expiresInSeconds: 30 },
  },
  // The live frame carries a message plus `keys`; the web app reads it as a StoredMessage.
  MessageFrameView: {
    view: contracts.MessageFrameView,
    web: v.object({ type: v.literal("message"), message: Web.StoredMessage }),
    sample: contracts.presentMessageFrame({
      id,
      senderId: other,
      body: "sealed",
      iv: "iv",
      keys: [{ fingerprint: "f".repeat(8), wrappedKey: "w".repeat(16), iv: "iv" }],
      createdAt: at,
    }),
  },

  // uploads
  LimitsView: {
    view: contracts.LimitsView,
    web: Web.UploadPolicy,
    sample: { enabled: true, imageTypes: ["image/png"], maxBytes: 1_000_000 },
  },
  UploadedView: { view: contracts.UploadedView, web: Web.Uploaded, sample: { url: "https://x" } },

  // common
  Created: { view: contracts.Created, web: Web.Opened, sample: { id } },
};

// Views the web app has no schema for: it ignores the body of these writes (or never sends the
// request), so there is nothing to hold them to. Listed rather than invented.
const noWebCounterpart = [
  "GrantedView", // admin: grantRealmAdmin ignores the body
  "BanView", // admin: setBan ignores the body
  "ReviewedView", // admin: reviewReport ignores the body
  "RemovedView", // comments: removeComment (moderate) ignores the body
  "RsvpView", // events: rsvp ignores the body
  "ClearedView", // events: rsvp(null) ignores the body
  "UpvotedView", // governance: write() returns the payload as unknown
  "UpvoteWithdrawnView",
  "SeatRemovedView",
  "RecallOpenedView",
  "RecallTallyView",
  "TakedownOpenedView",
  "TakedownTallyView",
  "JobStatusView", // postings: setPostingStatus / settle / setInterest ignore the body
  "ListingStatusView",
  "HiredView",
  "DealtView",
  "WithdrawnView",
  "FitDecisionView", // decideReview ignores the body
  "JoinedView", // realm: membership() ignores the body
  "LeftView",
  "EditedView", // no web caller yet
  "ArchivedView", // no web caller yet
  "RoleChangedView", // setRole ignores the body
  "ApprovedView", // proposals: write() returns the payload as unknown
  "RejectedView",
  "PublishedView", // rooms: key publication ignores the body
  "BlockedView", // setBlocked ignores the body
  "RetentionView", // no web caller yet
  "StaleDevicesFrameView", // socket frames the web app switches on by `type`, with no schema
  "ErrorFrameView",
];

describe("the web app's schemas parse every response view", () => {
  for (const [name, pair] of Object.entries(pairs)) {
    test(name, () => {
      const output = v.parse(pair.view, pair.sample);
      // What the client receives is the JSON text of the view's output.
      const wire: unknown = JSON.parse(JSON.stringify(output));
      expect(v.safeParse(pair.web, wire).issues).toBeUndefined();
    });
  }

  test("every exported view is either checked or listed as having no web counterpart", () => {
    const views = Object.keys(contracts).filter((key) => key.endsWith("View"));
    const accounted = new Set([...Object.keys(pairs), ...noWebCounterpart]);
    expect(views.filter((view) => !accounted.has(view))).toEqual([]);
    // A stale entry would hide a view that was renamed or removed.
    expect(noWebCounterpart.filter((view) => !views.includes(view))).toEqual([]);
    expect(Object.keys(pairs).filter((key) => key !== "Created" && !views.includes(key))).toEqual(
      [],
    );
  });
});
