import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Authorizer, FgaType, type Tuple } from '@akashic/authz';
import { auditEntries, createDb, realms, user } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { AuditAction } from '@akashic/lib/enums';
import { silentLogger } from '@akashic/lib/log';
import { grantPlatformAdmin } from '../../scripts/admin-grant.ts';
import { seedMissingCentroids } from '../../scripts/realm-centroids.ts';

// The two realm scripts' work, on the real database in a rolled-back transaction.

const database = createDb({
	url: Bun.env.DATABASE_URL ?? 'postgres://akashic:akashic@localhost:5432/akashic',
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const recording = () => {
	const changes: { writes?: readonly Tuple[]; deletes?: readonly Tuple[] }[] = [];
	const authorizer = {
		write: async (change: (typeof changes)[number]) => void changes.push(change),
	} as unknown as Authorizer;
	return { authorizer, changes };
};

describe.skipIf(!live)('admin:grant', () => {
	test('grants and revokes platform admin to a verified account, and records each', () =>
		withRollback(database.db, async (tx) => {
			const email = `grant-${Bun.randomUUIDv7()}@example.test`;
			const [account] = await tx
				.insert(user)
				.values({ name: 'Grantee', email, emailVerified: true })
				.returning({ id: user.id });
			const { authorizer, changes } = recording();

			await grantPlatformAdmin({ db: tx, authorizer, email, revoke: false });
			await grantPlatformAdmin({ db: tx, authorizer, email, revoke: true });

			const tuple: Tuple = {
				subject: { userId: account!.id },
				relation: 'admin',
				type: FgaType.platform,
				objectId: 'akashic',
			};
			expect(changes).toEqual([{ writes: [tuple] }, { deletes: [tuple] }]);
			const audits = await tx
				.select()
				.from(auditEntries)
				.where(eq(auditEntries.entityId, account!.id));
			expect(audits.map((a) => [a.action, a.userId, a.changes])).toEqual([
				[AuditAction.roleChanged, null, { platformAdmin: true, email, via: 'cli' }],
				[AuditAction.roleChanged, null, { platformAdmin: false, email, via: 'cli' }],
			]);
		}));

	test('refuses an unknown or unverified address, writing nothing', () =>
		withRollback(database.db, async (tx) => {
			const email = `grant-${Bun.randomUUIDv7()}@example.test`;
			const { authorizer, changes } = recording();
			await expect(
				grantPlatformAdmin({ db: tx, authorizer, email, revoke: false }),
			).rejects.toThrow('no account');
			await tx.insert(user).values({ name: 'Unverified', email, emailVerified: false });
			await expect(
				grantPlatformAdmin({ db: tx, authorizer, email, revoke: false }),
			).rejects.toThrow('not verified');
			expect(changes).toEqual([]);
		}));
});

describe.skipIf(!live)('realm:centroids', () => {
	test('seeds only the realms without a centroid', () =>
		withRollback(database.db, async (tx) => {
			const [founder] = await tx
				.insert(user)
				.values({ name: 'Founder', email: `centroid-${Bun.randomUUIDv7()}@example.test` })
				.returning({ id: user.id });
			const [mine] = await tx
				.insert(realms)
				.values({
					slug: `c-${Bun.randomUUIDv7().slice(-12)}`,
					name: 'Centroid',
					createdBy: founder!.id,
				})
				.returning({ id: realms.id });

			const asked: string[] = [];
			const result = await seedMissingCentroids(tx, {
				seedCentroid: async (realmId) => (asked.push(realmId), realmId === mine!.id),
			});
			expect(asked).toContain(mine!.id);
			expect(result.pending).toBe(asked.length);
			expect(result.seeded).toBe(1);
		}));
});
