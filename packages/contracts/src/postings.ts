import * as v from "valibot";
import {
  CommentSubject,
  InterestStatus,
  JobStatus,
  JobType,
  ListingStatus,
  narrow,
} from "@akashic/lib/enums";
import { iso, ListLimit, oneOf, Timestamp, trimmedAsSent, Uuid } from "./common.ts";

// The postings API contract: jobs, listings, interest in them, and the realm-fit review queue.
// (Services hold a Temporal.Instant; the presenters render it.)

// ---- Requests --------------------------------------------------------------------------------

const title = trimmedAsSent({ minLength: 3, maxLength: 140 });
const description = trimmedAsSent({ minLength: 1, maxLength: 8000 });
const currency = trimmedAsSent({ minLength: 3, maxLength: 3 });
const money = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(10 ** 12));
const Integer = v.pipe(v.number(), v.integer());

export const CreateJobBody = v.object({
  title,
  description,
  type: v.optional(oneOf(JobType), JobType.commission),
  budgetCents: v.optional(money),
  currency,
  hiringFlow: v.optional(trimmedAsSent({ maxLength: 2000 })),
});

export const CreateListingBody = v.object({
  title,
  description,
  priceCents: money,
  currency,
  imageUrl: v.optional(v.pipe(v.string(), v.maxLength(500), v.url())),
});

export const ListPostingsQuery = v.object({
  show: v.optional(v.picklist(["open", "all"]), "open"),
  limit: ListLimit,
});

// A job is filled only by hiring, so a status change can only open or close it.
export const JobStatusBody = v.object({ status: v.picklist([JobStatus.open, JobStatus.closed]) });
export const ListingStatusBody = v.object({ status: oneOf(ListingStatus) });
export const HireBody = v.object({ userId: Uuid });
export const DealBody = v.object({ buyerId: Uuid });
export const InterestBody = v.object({ note: v.optional(trimmedAsSent({ maxLength: 1000 })) });
export const FitDecisionBody = v.object({ kept: v.boolean() });

// ---- What the service holds --------------------------------------------------------------------

export interface JobSummary {
  id: string;
  title: string;
  type: number;
  budgetCents: number | null;
  currency: string;
  status: number;
  createdAt: Temporal.Instant;
}

export interface Job extends JobSummary {
  description: string;
  hiringFlow: string | null;
  hiredUserId: string | null;
  commentsEnabled: boolean;
  authorId: string;
  authorName: string;
}

export interface ListingSummary {
  id: string;
  title: string;
  priceCents: number;
  currency: string;
  status: number;
  imageUrl: string | null;
  createdAt: Temporal.Instant;
}

export interface Listing extends ListingSummary {
  description: string;
  buyerId: string | null;
  commentsEnabled: boolean;
  sellerId: string;
  sellerName: string;
}

export interface Interest {
  id: string;
  userId: string;
  userName: string;
  note: string | null;
  status: number;
  createdAt: Temporal.Instant;
}

export interface FitReview {
  id: string;
  subjectKind: number;
  subjectId: string;
  distance: number;
  createdAt: Temporal.Instant;
}

// ---- Responses -------------------------------------------------------------------------------

export const JobSummaryView = v.object({
  id: v.string(),
  title: v.string(),
  type: oneOf(JobType),
  budgetCents: v.nullable(Integer),
  currency: v.string(),
  status: oneOf(JobStatus),
  createdAt: Timestamp,
});

export const JobView = v.object({
  ...JobSummaryView.entries,
  description: v.string(),
  hiringFlow: v.nullable(v.string()),
  hiredUserId: v.nullable(v.string()),
  commentsEnabled: v.boolean(),
  authorId: v.string(),
  authorName: v.string(),
  viewerInterested: v.boolean(),
});

export const ListingSummaryView = v.object({
  id: v.string(),
  title: v.string(),
  priceCents: Integer,
  currency: v.string(),
  status: oneOf(ListingStatus),
  imageUrl: v.nullable(v.string()),
  createdAt: Timestamp,
});

export const ListingView = v.object({
  ...ListingSummaryView.entries,
  description: v.string(),
  buyerId: v.nullable(v.string()),
  commentsEnabled: v.boolean(),
  sellerId: v.string(),
  sellerName: v.string(),
  viewerInterested: v.boolean(),
});

export const InterestView = v.object({
  id: v.string(),
  userId: v.string(),
  userName: v.string(),
  note: v.nullable(v.string()),
  status: oneOf(InterestStatus),
  createdAt: Timestamp,
});

export const FitReviewView = v.object({
  id: v.string(),
  subjectKind: oneOf(CommentSubject),
  subjectId: v.string(),
  distance: v.number(),
  createdAt: Timestamp,
});

export const JobStatusView = v.object({ status: oneOf(JobStatus) });
export const ListingStatusView = v.object({ status: oneOf(ListingStatus) });
export const HiredView = v.object({ hiredUserId: v.string() });
export const DealtView = v.object({ buyerId: v.string() });
export const WithdrawnView = v.object({ withdrawn: v.boolean() });
export const FitDecisionView = v.object({ kept: v.boolean() });

// ---- Presenters: service types onto response shapes, field by field ----------------------------

export function presentJobSummary(job: JobSummary): v.InferInput<typeof JobSummaryView> {
  return {
    id: job.id,
    title: job.title,
    type: narrow(JobType, job.type),
    budgetCents: job.budgetCents,
    currency: job.currency,
    status: narrow(JobStatus, job.status),
    createdAt: iso(job.createdAt),
  };
}

export function presentJob(job: Job & { viewerInterested: boolean }): v.InferInput<typeof JobView> {
  return {
    ...presentJobSummary(job),
    description: job.description,
    hiringFlow: job.hiringFlow,
    hiredUserId: job.hiredUserId,
    commentsEnabled: job.commentsEnabled,
    authorId: job.authorId,
    authorName: job.authorName,
    viewerInterested: job.viewerInterested,
  };
}

export function presentListingSummary(
  listing: ListingSummary,
): v.InferInput<typeof ListingSummaryView> {
  return {
    id: listing.id,
    title: listing.title,
    priceCents: listing.priceCents,
    currency: listing.currency,
    status: narrow(ListingStatus, listing.status),
    imageUrl: listing.imageUrl,
    createdAt: iso(listing.createdAt),
  };
}

export function presentListing(
  listing: Listing & { viewerInterested: boolean },
): v.InferInput<typeof ListingView> {
  return {
    ...presentListingSummary(listing),
    description: listing.description,
    buyerId: listing.buyerId,
    commentsEnabled: listing.commentsEnabled,
    sellerId: listing.sellerId,
    sellerName: listing.sellerName,
    viewerInterested: listing.viewerInterested,
  };
}

export function presentInterest(interest: Interest): v.InferInput<typeof InterestView> {
  return {
    id: interest.id,
    userId: interest.userId,
    userName: interest.userName,
    note: interest.note,
    status: narrow(InterestStatus, interest.status),
    createdAt: iso(interest.createdAt),
  };
}

export function presentFitReview(review: FitReview): v.InferInput<typeof FitReviewView> {
  return {
    id: review.id,
    subjectKind: narrow(CommentSubject, review.subjectKind),
    subjectId: review.subjectId,
    distance: review.distance,
    createdAt: iso(review.createdAt),
  };
}
