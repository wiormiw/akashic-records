import { isNull } from 'drizzle-orm';
import * as v from 'valibot';
import { createDb, type Executor, realms } from '@akashic/db';
import { loadEnv } from '@akashic/lib/config';
import { createLogger } from '@akashic/lib/log';
import { systemClock } from '@akashic/lib/time';
import { Env } from '@/config.ts';
import { createEmbedder } from '@/integrations/embedder.ts';
import { createRealmService, type RealmService } from '@/modules/realm/realm.service.ts';

// Gives every realm without a centroid one, from its name and description, so posting fit can
// be judged. Realms founded while no embedding model was configured are the ones this catches.
// Safe to rerun: a realm that has a centroid is skipped.

/** Seeds each realm still without a centroid; answers how many of how many. */
export async function seedMissingCentroids(
	db: Executor,
	service: Pick<RealmService, 'seedCentroid'>,
): Promise<{ seeded: number; pending: number }> {
	const pending = await db
		.select({ id: realms.id, name: realms.name, description: realms.description })
		.from(realms)
		.where(isNull(realms.centroid));

	let seeded = 0;
	for (const realm of pending) {
		if (await service.seedCentroid(realm.id, realm.name, realm.description)) seeded++;
	}
	return { seeded, pending: pending.length };
}

if (import.meta.main) {
	const env = loadEnv(
		v.pick(Env, [
			'DATABASE_URL',
			'AI_PROVIDER',
			'AI_API_KEY',
			'AI_BASE_URL',
			'AI_EMBED_MODEL',
			'AI_TIMEOUT_MS',
			'AI_ATTEMPTS',
		]),
		Bun.env,
	);
	const logger = createLogger({
		level: 'warn',
		service: 'akashic-realm-centroids',
		environment: 'script',
	});
	const database = createDb({
		url: env.DATABASE_URL,
		poolMax: 2,
		idleTimeoutS: 30,
		connectTimeoutS: 10,
		logger,
	});
	const embedder = createEmbedder({
		provider: env.AI_PROVIDER,
		apiKey: env.AI_API_KEY,
		baseUrl: env.AI_BASE_URL,
		model: env.AI_EMBED_MODEL,
		timeoutMs: env.AI_TIMEOUT_MS,
		attempts: env.AI_ATTEMPTS,
		logger,
	});
	try {
		if (!embedder.available) {
			throw new Error('no embedding model is configured (AI_PROVIDER, AI_API_KEY)');
		}
		const service = createRealmService({ db: database.db, embedder, clock: systemClock });
		const { seeded, pending } = await seedMissingCentroids(database.db, service);
		console.log(`seeded ${seeded} of ${pending} realms without a centroid`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	} finally {
		await database[Symbol.asyncDispose]();
	}
}
