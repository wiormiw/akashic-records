import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, listings } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { AuditAction, CommentSubject, InterestStatus, ListingStatus } from '@akashic/lib/enums';
import { MemberNotFound } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { expectErr, expectOk } from '@akashic/lib/testing';
import { toDate } from '@akashic/lib/time';
import { clock, databaseUrl } from '../../support/fixtures.ts';
import { world } from './fixtures.ts';

// The listings service on the real database, each test in a transaction that is rolled back.

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (run: (w: ReturnType<typeof world>) => Promise<void>) =>
	withRollback(database.db, (tx) => run(world(tx)));

describe.skipIf(!live)('the marketplace', () => {
	test("lists a realm's listings newest first, active only unless asked", () =>
		inWorld(async (w) => {
			const realm = await w.realm();
			const elsewhere = await w.realm();
			const first = await w.seed(realm.id, realm.admin);
			const second = await w.seed(realm.id, realm.admin);
			await w.seed(elsewhere.id, elsewhere.admin);
			// Within one transaction now() is fixed: date the first an hour back to order them.
			await w.tx
				.update(listings)
				.set({ createdAt: new Date(Date.now() - 3_600_000) })
				.where(eq(listings.id, first.listing.id));
			expectOk(
				await w.listings.setStatus(
					realm.id,
					second.listing.id,
					realm.admin,
					ListingStatus.sold,
					false,
				),
			);

			expect((await w.listings.browse(realm.id, true, 20)).map((l) => l.id)).toEqual([
				first.listing.id,
			]);
			expect((await w.listings.browse(realm.id, false, 20)).map((l) => l.id)).toEqual([
				second.listing.id,
				first.listing.id,
			]);
		}));

	test('reads a listing with its seller and whether the viewer offered', () =>
		inWorld(async (w) => {
			const realm = await w.realm({ members: 1 });
			const { listing } = await w.seed(realm.id, realm.admin);
			const reader = realm.people[0]!;
			expect(expectOk(await w.listings.read(realm.id, listing.id, reader))).toMatchObject({
				sellerId: realm.admin,
				sellerName: 'Founder',
				priceCents: 1500,
				status: ListingStatus.active,
				buyerId: null,
				viewerInterested: false,
			});
			expectOk(await w.interest.show(realm.id, listing, reader, 'Mine?'));
			expect(expectOk(await w.listings.read(realm.id, listing.id, reader)).viewerInterested).toBe(
				true,
			);
		}));

	test("removing a listing is a moderator's call", () =>
		inWorld(async (w) => {
			const realm = await w.realm();
			const { listing } = await w.seed(realm.id, realm.admin);
			expectErr(
				await w.listings.setStatus(realm.id, listing.id, realm.admin, ListingStatus.removed, false),
				'realm.forbidden',
			);
			expect((await w.listing(listing.id))?.status).toBe(ListingStatus.active);
			expect(
				expectOk(
					await w.listings.setStatus(
						realm.id,
						listing.id,
						realm.admin,
						ListingStatus.removed,
						true,
					),
				),
			).toEqual({ status: ListingStatus.removed });
		}));

	test("a moderator's change to someone else's listing is audited; the seller's own is not", () =>
		inWorld(async (w) => {
			const realm = await w.realm({ members: 1 });
			const seller = realm.people[0]!;
			const { listing } = await w.seed(realm.id, seller);

			expectOk(await w.listings.setStatus(realm.id, listing.id, seller, ListingStatus.sold, false));
			expect(await w.audits(listing.id)).toEqual([]);

			expectOk(
				await w.listings.setStatus(realm.id, listing.id, realm.admin, ListingStatus.removed, true),
			);
			expect(await w.audits(listing.id)).toEqual([
				expect.objectContaining({
					userId: realm.admin,
					entityType: 'listing',
					entityId: listing.id,
					action: AuditAction.moderated,
					changes: { by: 'moderator', status: ListingStatus.removed },
				}),
			]);
		}));

	test('a listing of another realm is not found to read, change or deal, and stays', () =>
		inWorld(async (w) => {
			const realm = await w.realm();
			const elsewhere = await w.realm({ members: 1 });
			const { listing } = await w.seed(elsewhere.id, elsewhere.admin);
			const buyer = elsewhere.people[0]!;
			expectOk(await w.interest.show(elsewhere.id, listing, buyer, undefined));

			expectErr(await w.listings.read(realm.id, listing.id, realm.admin), 'event.not_found');
			expectErr(
				await w.listings.setStatus(realm.id, listing.id, realm.admin, ListingStatus.removed, true),
				'event.not_found',
			);
			expectErr(
				await w.listings.deal(realm.id, listing.id, elsewhere.admin, buyer),
				'event.not_found',
			);
			expect((await w.listing(listing.id))?.status).toBe(ListingStatus.active);
			expect(await w.interestOf(listing.id, buyer)).toBe(InterestStatus.open);
		}));
});

describe.skipIf(!live)('deals', () => {
	test('a deal sells to the chosen buyer, declines the rest, and closes only once', () =>
		inWorld(async (w) => {
			const realm = await w.realm({ members: 3 });
			const [seller, buyer, other] = realm.people as [string, string, string];
			const { id: listingId } = expectOk(
				await w.listings.post({
					realmId: realm.id,
					sellerId: seller,
					title: 'Print',
					description: 'An A4 print.',
					priceCents: 1500,
					currency: 'IDR',
				}),
			);
			const subject = { kind: CommentSubject.listing, id: listingId };
			expectOk(await w.interest.show(realm.id, subject, buyer, 'Mine?'));
			expectOk(await w.interest.show(realm.id, subject, other, undefined));

			expectErr(await w.listings.deal(realm.id, listingId, buyer, buyer), 'realm.forbidden');
			expectErr(
				await w.listings.deal(realm.id, listingId, seller, seller),
				'common.request.validation_failed',
			);
			expect(expectOk(await w.listings.deal(realm.id, listingId, seller, buyer))).toEqual({
				buyerId: buyer,
			});
			expect(await w.listing(listingId)).toMatchObject({
				status: ListingStatus.sold,
				buyerId: buyer,
				soldAt: toDate(clock.now()),
				updatedAt: toDate(clock.now()),
			});
			expect(await w.interestOf(listingId, buyer)).toBe(InterestStatus.accepted);
			expect(await w.interestOf(listingId, other)).toBe(InterestStatus.declined);
			expectErr(
				await w.listings.deal(realm.id, listingId, seller, other),
				'posting.already_settled',
			);
		}));

	test('a buyer must be a member who still has an offer in', () =>
		inWorld(async (w) => {
			const realm = await w.realm({ members: 1 });
			const { listing } = await w.seed(realm.id, realm.admin);
			const buyer = realm.people[0]!;
			const outsider = await w.person('Outsider');
			expectErr(await w.listings.deal(realm.id, listing.id, realm.admin, outsider), MemberNotFound);
			expectOk(await w.interest.show(realm.id, listing, buyer, undefined));
			expectOk(await w.interest.drop(realm.id, listing, buyer));
			expectErr(
				await w.listings.deal(realm.id, listing.id, realm.admin, buyer),
				'common.request.validation_failed',
			);
			expect((await w.listing(listing.id))?.status).toBe(ListingStatus.active);
		}));
});
