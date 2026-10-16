import { afterAll, describe, expect, test } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { auditEntries, createDb, outboxMessages, realmMembers, realms, user } from '@akashic/db';
import { RealmRole, RecallKind, RecallStatus } from '@akashic/lib/enums';
import { ErrorCode } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { expectOk } from '@akashic/lib/testing';
import { createGovernanceServices } from '@/modules/governance/governance.module.ts';
import { clock, databaseUrl, uniqueSlug } from '../../support/fixtures.ts';

// Deciding votes cast at the same moment need separate connections, so this can't run inside one
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

describe.skipIf(!live)('deciding a recall at the same moment', () => {
	test('every deciding vote answers carried or settled, and the moderator is unseated once', async () => {
		const { db } = database;
		const tag = Bun.randomUUIDv7();
		// The founder, the moderator and five members: seven, so a majority is four.
		const people = Array.from({ length: 7 }, () => Bun.randomUUIDv7());
		const [admin, moderator, proposer, second, third, ...late] = people as [
			string,
			string,
			string,
			string,
			string,
			...string[],
		];
		let realmId: string | undefined;
		try {
			await db.insert(user).values(
				people.map((id, i) => ({
					id,
					name: `Voter ${i}`,
					email: `recall-${i}-${tag}@example.test`,
				})),
			);
			const [realm] = await db
				.insert(realms)
				.values({ slug: uniqueSlug('recall'), name: 'Recall race', createdBy: admin })
				.returning({ id: realms.id });
			realmId = realm!.id;
			await db.insert(realmMembers).values(
				people.map((userId) => ({
					realmId: realmId!,
					userId,
					role:
						userId === admin
							? RealmRole.admin
							: userId === moderator
								? RealmRole.moderator
								: RealmRole.member,
				})),
			);

			const { recalls } = createGovernanceServices({ db, clock });
			const { id: recallId } = expectOk(
				await recalls.proposeRecall(
					realmId,
					moderator,
					RecallKind.members,
					'Not doing the job.',
					proposer,
				),
			);
			for (const voter of [second, third]) {
				expectOk(await recalls.voteOnRecall(realmId, recallId, voter, true));
			}

			// Three votes, any of which reaches four agrees on its own.
			const answers = await Promise.all(
				[admin, ...late].map((voter) => recalls.voteOnRecall(realmId!, recallId, voter, true)),
			);
			for (const answer of answers) {
				if (answer.ok) expect(answer.value.status).toBe(RecallStatus.carried);
				else expect(answer.error.code).toBe(ErrorCode.realm.alreadyMember);
			}
			expect(answers.some((answer) => answer.ok)).toBe(true);

			const [row] = await db
				.select({ role: realmMembers.role })
				.from(realmMembers)
				.where(sql`${realmMembers.realmId} = ${realmId} AND ${realmMembers.userId} = ${moderator}`);
			expect(row?.role).toBe(RealmRole.member);
			// Unseated by exactly one vote: one announcement, one entry on the record.
			const changes = await db
				.select({ payload: outboxMessages.payload })
				.from(outboxMessages)
				.where(
					sql`${outboxMessages.messageType} = 'realm.member_changed' AND ${outboxMessages.payload}->>'realmId' = ${realmId}`,
				);
			expect(changes.map((change) => change.payload)).toEqual([
				{ realmId, userId: moderator, role: RealmRole.member },
			]);
			expect(
				await db.select().from(auditEntries).where(eq(auditEntries.entityId, moderator)),
			).toHaveLength(1);
		} finally {
			if (realmId) {
				await db
					.delete(outboxMessages)
					.where(sql`${outboxMessages.payload}->>'realmId' = ${realmId}`);
				// Members, recalls and their votes cascade from the realm.
				await db.delete(realms).where(eq(realms.id, realmId));
			}
			await db.delete(auditEntries).where(inArray(auditEntries.entityId, people));
			await db.delete(user).where(inArray(user.id, people));
		}
	});
});
