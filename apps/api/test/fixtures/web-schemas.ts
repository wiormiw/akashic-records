import * as v from "valibot";

// The web app's response schemas, copied from akashic_records_fe/src/lib/api/*.ts (Valibot, the
// same library). The browser parses every response with these, so the contract test holds the
// API to them. Plan 3 deletes this file: the web app then imports @akashic/contracts directly.
// Keep each schema as the web app writes it, loose `v.number()` and all.

// ---- realms.ts -------------------------------------------------------------------------------

const RealmSummary = v.object({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  description: v.nullable(v.string()),
  category: v.nullable(v.string()),
  memberCount: v.number(),
  modules: v.array(v.number()),
});

const Standing = v.object({
  role: v.nullable(v.number()),
  permissions: v.array(v.string()),
});

const EventTeaser = v.object({
  id: v.string(),
  title: v.string(),
  startsAt: v.string(),
  capacity: v.nullable(v.number()),
  imageUrl: v.nullable(v.string()),
  goingCount: v.number(),
});

const EventDetail = v.object({
  ...EventTeaser.entries,
  description: v.string(),
  endsAt: v.nullable(v.string()),
  location: v.nullable(v.string()),
  authorId: v.string(),
  authorName: v.string(),
  commentsEnabled: v.boolean(),
  yourRsvp: v.nullable(v.number()),
});

const JobTeaser = v.object({
  id: v.string(),
  title: v.string(),
  type: v.number(),
  budgetCents: v.nullable(v.number()),
  currency: v.string(),
  status: v.number(),
  createdAt: v.string(),
});

const JobDetail = v.object({
  ...JobTeaser.entries,
  description: v.string(),
  authorId: v.string(),
  authorName: v.string(),
  commentsEnabled: v.boolean(),
  hiringFlow: v.nullable(v.string()),
  hiredUserId: v.nullable(v.string()),
  viewerInterested: v.boolean(),
});

const ListingTeaser = v.object({
  id: v.string(),
  title: v.string(),
  priceCents: v.number(),
  currency: v.string(),
  status: v.number(),
  imageUrl: v.nullable(v.string()),
  createdAt: v.string(),
});

const ListingDetail = v.object({
  ...ListingTeaser.entries,
  description: v.string(),
  sellerId: v.string(),
  sellerName: v.string(),
  commentsEnabled: v.boolean(),
  buyerId: v.nullable(v.string()),
  viewerInterested: v.boolean(),
});

const Comment = v.object({
  id: v.string(),
  body: v.string(),
  authorId: v.string(),
  authorName: v.string(),
  authorImage: v.nullable(v.string()),
  removed: v.boolean(),
  createdAt: v.string(),
});

const Interest = v.object({
  id: v.string(),
  userId: v.string(),
  userName: v.string(),
  note: v.nullable(v.string()),
  status: v.number(),
  createdAt: v.string(),
});

const Member = v.object({
  userId: v.string(),
  name: v.string(),
  displayName: v.nullable(v.string()),
  image: v.nullable(v.string()),
  role: v.number(),
  joinedAt: v.string(),
});

const Review = v.object({
  id: v.string(),
  subjectKind: v.number(),
  subjectId: v.string(),
  distance: v.number(),
  createdAt: v.string(),
});

/** createRealm reads `slug` from the answer; the web app declares no schema for it. */
const Founded = v.object({ slug: v.string() });

// ---- proposals.ts ----------------------------------------------------------------------------

const Proposal = v.object({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  description: v.nullable(v.string()),
  category: v.nullable(v.string()),
  modules: v.array(v.number()),
  rationale: v.string(),
  proposedBy: v.nullable(v.object({ id: v.string(), name: v.string(), email: v.string() })),
  status: v.number(),
  decisionNote: v.nullable(v.string()),
  decidedAt: v.nullable(v.string()),
  realmId: v.nullable(v.string()),
  createdAt: v.string(),
});

// ---- governance.ts ---------------------------------------------------------------------------

const Named = v.object({ id: v.string(), name: v.string() });

const Standings = v.object({
  seats: v.number(),
  minimum: v.number(),
  members: v.array(
    v.object({
      userId: v.string(),
      name: v.string(),
      role: v.number(),
      upvotes: v.number(),
      seated: v.boolean(),
      joinedAt: v.string(),
    }),
  ),
});

const Recall = v.object({
  id: v.string(),
  realmId: v.string(),
  subject: v.nullable(Named),
  kind: v.number(),
  reason: v.string(),
  proposedBy: v.nullable(Named),
  status: v.number(),
  agrees: v.number(),
  refusals: v.number(),
  createdAt: v.string(),
});

const Takedown = v.object({
  id: v.string(),
  realmId: v.string(),
  subjectKind: v.number(),
  subjectId: v.string(),
  reason: v.string(),
  proposedBy: v.nullable(Named),
  status: v.number(),
  agrees: v.number(),
  refusals: v.number(),
  needed: v.number(),
  createdAt: v.string(),
});

// ---- platform.ts -----------------------------------------------------------------------------

const Account = v.object({ id: v.string(), name: v.string(), email: v.string() });

const Overview = v.object({
  realms: v.number(),
  archived: v.number(),
  orphaned: v.number(),
  members: v.number(),
  openReports: v.number(),
  auditEntries: v.number(),
});

const PlatformRealm = v.object({
  id: v.string(),
  slug: v.string(),
  name: v.string(),
  category: v.nullable(v.string()),
  memberCount: v.number(),
  adminCount: v.number(),
  archivedAt: v.nullable(v.string()),
  createdAt: v.string(),
  createdBy: v.nullable(Account),
});

const AuditEntry = v.object({
  id: v.string(),
  actor: v.nullable(Account),
  entityType: v.string(),
  entityId: v.string(),
  action: v.number(),
  changes: v.nullable(v.record(v.string(), v.unknown())),
  traceId: v.nullable(v.string()),
  occurredAt: v.string(),
});

const Report = v.object({
  id: v.string(),
  roomId: v.string(),
  messageId: v.nullable(v.string()),
  reason: v.string(),
  disclosedText: v.nullable(v.string()),
  reporter: v.nullable(Account),
  accused: v.nullable(Account),
  senderMatches: v.nullable(v.boolean()),
  reviewedAt: v.nullable(v.string()),
  createdAt: v.string(),
});

const PlatformAccount = v.object({
  id: v.string(),
  name: v.string(),
  email: v.string(),
  emailVerified: v.boolean(),
  createdAt: v.string(),
  bannedAt: v.nullable(v.string()),
  banReason: v.nullable(v.string()),
  bannedUntil: v.nullable(v.string()),
  realmCount: v.number(),
});

// ---- rooms.ts --------------------------------------------------------------------------------

const PublicKeys = v.object({
  userId: v.string(),
  publicKey: v.string(),
  signingKey: v.nullable(v.string()),
  fingerprint: v.string(),
});

const RoomSummary = v.object({
  id: v.string(),
  realmId: v.string(),
  subjectKind: v.number(),
  subjectId: v.string(),
  otherId: v.string(),
  otherName: v.string(),
  lastMessageAt: v.nullable(v.string()),
  createdAt: v.string(),
});

const StoredMessage = v.object({
  id: v.string(),
  senderId: v.string(),
  body: v.string(),
  iv: v.string(),
  signature: v.nullable(v.string()),
  createdAt: v.string(),
  wrappedKey: v.nullable(v.string()),
  keyIv: v.nullable(v.string()),
  keys: v.optional(
    v.array(v.object({ fingerprint: v.string(), wrappedKey: v.string(), iv: v.string() })),
  ),
});

const Ticket = v.object({ ticket: v.string(), expiresInSeconds: v.number() });

/** rooms.ts reads `{ id }` after starting a room. */
const Opened = v.object({ id: v.string() });

// ---- mail.ts, uploads.ts ---------------------------------------------------------------------

const MailStatus = v.object({
  configured: v.boolean(),
  healthy: v.boolean(),
  lastFailure: v.nullable(v.string()),
  failedAt: v.nullable(v.string()),
});

const UploadPolicy = v.object({
  enabled: v.boolean(),
  imageTypes: v.array(v.string()),
  maxBytes: v.number(),
});

/** uploadImage reads `url` from the answer; the web app declares no schema for it. */
const Uploaded = v.object({ url: v.string() });

export const Web = {
  RealmSummary,
  Standing,
  EventTeaser,
  EventDetail,
  JobTeaser,
  JobDetail,
  ListingTeaser,
  ListingDetail,
  Comment,
  Interest,
  Member,
  Review,
  Founded,
  Proposal,
  Standings,
  Recall,
  Takedown,
  Overview,
  PlatformRealm,
  AuditEntry,
  Report,
  PlatformAccount,
  PublicKeys,
  RoomSummary,
  StoredMessage,
  Ticket,
  Opened,
  MailStatus,
  UploadPolicy,
  Uploaded,
};
