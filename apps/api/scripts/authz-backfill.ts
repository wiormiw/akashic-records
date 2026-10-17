import * as v from 'valibot';
import { createAuthorizer, FgaType, PLATFORM_ID, RANK_RELATION, type Tuple } from '@akashic/authz';
import { createDb, realmMembers, realms } from '@akashic/db';
import { loadEnv } from '@akashic/lib/config';
import { createLogger } from '@akashic/lib/log';
import { Env } from '@/config.ts';

// Rewrites every realm and membership tuple from Postgres, for a fresh store or one that drifted.
// Safe to rerun: each membership's ranks are deleted and its current one written.
const PAGE = 50;

if (import.meta.main) {
	const env = loadEnv(
		v.pick(Env, ['DATABASE_URL', 'FGA_API_URL', 'FGA_STORE_ID', 'FGA_MODEL_ID', 'FGA_TIMEOUT_MS']),
		Bun.env,
	);
	const logger = createLogger({
		level: 'warn',
		service: 'akashic-authz-backfill',
		environment: 'script',
	});
	const database = createDb({
		url: env.DATABASE_URL,
		poolMax: 2,
		idleTimeoutS: 30,
		connectTimeoutS: 10,
		logger,
	});
	const authorizer = createAuthorizer({
		apiUrl: env.FGA_API_URL,
		storeId: env.FGA_STORE_ID,
		modelId: env.FGA_MODEL_ID,
		timeoutMs: env.FGA_TIMEOUT_MS,
		logger,
	});
	try {
		const allRealms = await database.db.select({ id: realms.id }).from(realms);
		const memberships = await database.db
			.select({
				realmId: realmMembers.realmId,
				userId: realmMembers.userId,
				role: realmMembers.role,
			})
			.from(realmMembers);

		for (let i = 0; i < allRealms.length; i += PAGE) {
			await authorizer.write({
				writes: allRealms.slice(i, i + PAGE).map(({ id }) => ({
					subject: { type: FgaType.platform, objectId: PLATFORM_ID },
					relation: 'platform',
					type: FgaType.realm,
					objectId: id,
				})),
			});
		}

		for (const [i, { realmId, userId, role }] of memberships.entries()) {
			const tuple = (relation: string): Tuple => ({
				subject: { userId },
				relation,
				type: FgaType.realm,
				objectId: realmId,
			});
			const rank = RANK_RELATION[role];
			if (!rank)
				throw new Error(
					`realm_member (${realmId}, ${userId}) has role ${role}, unknown to the model`,
				);
			await authorizer.write({ writes: [tuple(rank)], deletes: RANK_RELATION.map(tuple) });
			if ((i + 1) % PAGE === 0) console.log(`${i + 1}/${memberships.length}`);
		}

		console.log(`synced ${allRealms.length} realms and ${memberships.length} memberships`);
	} finally {
		await database[Symbol.asyncDispose]();
	}
}
