import { afterAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { FgaType, Relation } from '@akashic/authz';
import {
	createDb,
	jobs,
	listings,
	outboxMessages,
	postingInterests,
	realmMembers,
	realmModules,
	realms,
	user,
} from '@akashic/db';
import { CommentSubject, InterestStatus, RealmModule, RealmRole } from '@akashic/lib/enums';
import { silentLogger } from '@akashic/lib/log';
import { postingsApp } from './app.ts';
import { databaseUrl, uniqueSlug } from '../../support/fixtures.ts';

// Two hires (or two deals) at the same moment need two connections, so this can't run inside one
// rolled-back transaction: it commits its own uniquely named rows and deletes exactly those.

const database = createDb({
	url: databaseUrl,
	poolMax: 8,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)('settling at the same moment', () => {
	test('two hires, two deals: one each is 200, the other 409, one accepted interest', async () => {
		const { db } = database;
		const tag = Bun.randomUUIDv7();
		const [owner, a, b] = [Bun.randomUUIDv7(), Bun.randomUUIDv7(), Bun.randomUUIDv7()];
		const slug = uniqueSlug('settle');
		let realmId: string | undefined;
		try {
			await db.insert(user).values(
				[owner, a, b].map((id, i) => ({
					id,
					name: `Settler ${i}`,
					email: `settle-${i}-${tag}@example.test`,
				})),
			);
			const [realm] = await db
				.insert(realms)
				.values({ slug, name: 'Settle race', createdBy: owner })
				.returning({ id: realms.id });
			realmId = realm!.id;
			await db
				.insert(realmModules)
				.values(
					[RealmModule.jobs, RealmModule.market].map((module) => ({ realmId: realmId!, module })),
				);
			await db
				.insert(realmMembers)
				.values(
					[owner, a, b].map((userId) => ({ realmId: realmId!, userId, role: RealmRole.member })),
				);
			const [job] = await db
				.insert(jobs)
				.values({ realmId, authorId: owner, title: 'One job', description: 'Only one.' })
				.returning({ id: jobs.id });
			const [listing] = await db
				.insert(listings)
				.values({
					realmId,
					sellerId: owner,
					title: 'One print',
					description: 'Only one.',
					priceCents: 100,
				})
				.returning({ id: listings.id });
			for (const [kind, subjectId] of [
				[CommentSubject.job, job!.id],
				[CommentSubject.listing, listing!.id],
			] as const) {
				await db
					.insert(postingInterests)
					.values(
						[a, b].map((userId) => ({ realmId: realmId!, subjectKind: kind, subjectId, userId })),
					);
			}

			const { call, grantOn } = postingsApp(db);
			grantOn(owner, Relation.posting.settle, FgaType.job, job!.id);
			grantOn(owner, Relation.posting.settle, FgaType.listing, listing!.id);

			const hires = await Promise.all(
				[a, b].map((userId) =>
					call('POST', `/api/v1/realms/${slug}/jobs/${job!.id}/hire`, {
						as: owner,
						body: { userId },
					}),
				),
			);
			const deals = await Promise.all(
				[a, b].map((buyerId) =>
					call('POST', `/api/v1/realms/${slug}/listings/${listing!.id}/deal`, {
						as: owner,
						body: { buyerId },
					}),
				),
			);

			for (const [answers, subjectId] of [
				[hires, job!.id],
				[deals, listing!.id],
			] as const) {
				expect(answers.map((r) => r.status).sort()).toEqual([200, 409]);
				expect(answers.find((r) => r.status === 409)?.body.code).toBe('posting.already_settled');
				const statuses = await db
					.select({ status: postingInterests.status })
					.from(postingInterests)
					.where(eq(postingInterests.subjectId, subjectId));
				// The loser settled nothing: one accepted, one declined by the winner.
				expect(statuses.map((s) => s.status).sort()).toEqual([
					InterestStatus.accepted,
					InterestStatus.declined,
				]);
			}
		} finally {
			if (realmId) {
				await db
					.delete(outboxMessages)
					.where(sql`${outboxMessages.payload}->>'realmId' = ${realmId}`);
				// Jobs, listings, interest, members and modules cascade from the realm.
				await db.delete(realms).where(eq(realms.id, realmId));
			}
			await db.delete(user).where(sql`${user.id} IN (${owner}, ${a}, ${b})`);
		}
	});
});
