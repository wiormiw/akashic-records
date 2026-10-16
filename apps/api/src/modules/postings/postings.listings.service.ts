import { and, desc, eq } from 'drizzle-orm';
import type { Listing, ListingSummary } from '@akashic/contracts';
import { audit, type Executor, inTransaction, listings, user } from '@akashic/db';
import { AuditAction, CommentSubject, ListingStatus } from '@akashic/lib/enums';
import {
	EventNotFound,
	PostingSettled,
	RealmForbidden,
	ValidationFailed,
} from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import { hasOpenInterest, requireMember, settleInterest } from './postings.interest.service.ts';
import type {
	DealError,
	Dealt,
	ListingForViewer,
	ListingStatusSet,
	NewListing,
	Posted,
	PostError,
	PostingAreaDeps,
	ReadListingError,
	SetListingStatusError,
} from './postings.types.ts';

const noListing = () => new EventNotFound('No such posting in this realm.');
const settled = () => new PostingSettled('This listing is no longer available.');

/** One listing of the realm; undefined for another realm's. */
async function findListing(
	db: Executor,
	realmId: string,
	listingId: string,
): Promise<Listing | undefined> {
	const [row] = await db
		.select({
			id: listings.id,
			title: listings.title,
			description: listings.description,
			priceCents: listings.priceCents,
			currency: listings.currency,
			status: listings.status,
			buyerId: listings.buyerId,
			imageUrl: listings.imageUrl,
			commentsEnabled: listings.commentsEnabled,
			sellerId: listings.sellerId,
			sellerName: user.name,
			createdAt: listings.createdAt,
		})
		.from(listings)
		.innerJoin(user, eq(user.id, listings.sellerId))
		.where(and(eq(listings.id, listingId), eq(listings.realmId, realmId)))
		.limit(1);
	return row && { ...row, createdAt: fromDate(row.createdAt) };
}

/** The marketplace: listings, their status, and deals. */
export function createListingService(deps: PostingAreaDeps) {
	const { db, clock, fit } = deps;

	return {
		/** A realm's listings, newest first. */
		async browse(realmId: string, activeOnly: boolean, limit: number): Promise<ListingSummary[]> {
			const rows = await db
				.select({
					id: listings.id,
					title: listings.title,
					priceCents: listings.priceCents,
					currency: listings.currency,
					status: listings.status,
					imageUrl: listings.imageUrl,
					createdAt: listings.createdAt,
				})
				.from(listings)
				.where(
					and(
						eq(listings.realmId, realmId),
						activeOnly ? eq(listings.status, ListingStatus.active) : undefined,
					),
				)
				.orderBy(desc(listings.createdAt))
				.limit(limit);
			return rows.map((row) => ({ ...row, createdAt: fromDate(row.createdAt) }));
		},

		async read(
			realmId: string,
			listingId: string,
			viewerId: string,
		): Promise<Result<ListingForViewer, ReadListingError>> {
			const listing = await findListing(db, realmId, listingId);
			if (!listing) return err(noListing());
			const subject = { kind: CommentSubject.listing, id: listingId };
			return ok({ ...listing, viewerInterested: await hasOpenInterest(db, subject, viewerId) });
		},

		post: (listing: NewListing): Promise<Result<Posted, PostError>> =>
			fit.admit(
				{ ...listing, type: 'listing', kind: CommentSubject.listing, authorId: listing.sellerId },
				async (tx) => {
					const [created] = await tx
						.insert(listings)
						.values(listing)
						.returning({ id: listings.id });
					if (!created) throw new Error('listing insert returned no row');
					return created.id;
				},
			),

		/** By its seller, or by a moderator, whose change to someone else's listing is audited. */
		async setStatus(
			realmId: string,
			listingId: string,
			actorId: string,
			status: ListingStatus,
			canModerate: boolean,
		): Promise<Result<ListingStatusSet, SetListingStatusError>> {
			if (status === ListingStatus.removed && !canModerate) {
				return err(new RealmForbidden("Removing a listing is a moderator's call."));
			}
			return inTransaction(db, async (tx) => {
				const [updated] = await tx
					.update(listings)
					.set({ status, updatedAt: toDate(clock.now()) })
					.where(and(eq(listings.id, listingId), eq(listings.realmId, realmId)))
					.returning({ sellerId: listings.sellerId });
				if (!updated) return err(noListing());
				if (updated.sellerId !== actorId) {
					await audit(tx, {
						actorId,
						entityType: 'listing',
						entityId: listingId,
						action: AuditAction.moderated,
						changes: { by: 'moderator', status },
					});
				}
				return ok({ status });
			});
		},

		/** Sells to one buyer: marks the listing sold and settles every other offer. */
		async deal(
			realmId: string,
			listingId: string,
			actorId: string,
			buyerId: string,
		): Promise<Result<Dealt, DealError>> {
			const listing = await findListing(db, realmId, listingId);
			if (!listing) return err(noListing());
			if (listing.sellerId !== actorId) {
				return err(new RealmForbidden('Only the seller can close a deal.'));
			}
			if (listing.status !== ListingStatus.active) return err(settled());
			const member = await requireMember(db, realmId, buyerId);
			if (!member.ok) return member;
			const subject = { kind: CommentSubject.listing, id: listingId };
			if (!(await hasOpenInterest(db, subject, buyerId))) {
				return err(new ValidationFailed('That buyer has not offered, or has withdrawn.'));
			}

			return inTransaction(db, async (tx) => {
				// Only an active listing sells: of two deals at once, the second finds it sold and
				// settles nothing.
				const sold = await tx
					.update(listings)
					.set({
						status: ListingStatus.sold,
						buyerId,
						soldAt: toDate(clock.now()),
						updatedAt: toDate(clock.now()),
					})
					.where(
						and(
							eq(listings.id, listingId),
							eq(listings.realmId, realmId),
							eq(listings.status, ListingStatus.active),
						),
					)
					.returning({ id: listings.id });
				if (sold.length === 0) return err(settled());
				await settleInterest(tx, subject, buyerId);
				return ok({ buyerId });
			});
		},
	};
}
