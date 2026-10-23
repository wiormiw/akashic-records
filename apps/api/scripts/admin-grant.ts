import { eq } from 'drizzle-orm';
import * as v from 'valibot';
import { createAuthorizer, FgaType, PLATFORM_ID, type Authorizer } from '@akashic/authz';
import { audit, createDb, type Executor, inTransaction, user } from '@akashic/db';
import { first } from '@akashic/db/sql';
import { loadEnv } from '@akashic/lib/config';
import { AuditAction } from '@akashic/lib/enums';
import { createLogger } from '@akashic/lib/log';
import { ok } from '@akashic/lib/result';
import { Env } from '@/config.ts';

// Platform authority over every realm. The account must exist and have verified its address.
//
//   bun run admin:grant <email>            grant
//   bun run admin:grant <email> --revoke   revoke

/** Grants or revokes platform administration, and records who it went to. */
export async function grantPlatformAdmin(options: {
	db: Executor;
	authorizer: Authorizer;
	email: string;
	revoke: boolean;
}): Promise<{ id: string; name: string }> {
	const { db, authorizer, email, revoke } = options;
	const account = first(
		await db
			.select({ id: user.id, name: user.name, verified: user.emailVerified })
			.from(user)
			.where(eq(user.email, email)),
	);
	if (!account) throw new Error(`no account for ${email}; register it first`);
	if (!account.verified) throw new Error(`${email} has not verified its address`);

	const tuple = {
		subject: { userId: account.id },
		relation: 'admin',
		type: FgaType.platform,
		objectId: PLATFORM_ID,
	};
	await authorizer.write(revoke ? { deletes: [tuple] } : { writes: [tuple] });
	await inTransaction(db, async (tx) => {
		await audit(tx, {
			actorId: null,
			entityType: 'platform',
			entityId: account.id,
			action: AuditAction.roleChanged,
			changes: { platformAdmin: !revoke, email, via: 'cli' },
		});
		return ok(undefined);
	});
	return { id: account.id, name: account.name };
}

if (import.meta.main) {
	const [email, flag] = Bun.argv.slice(2);
	if (!email) {
		console.error('usage: admin:grant <email> [--revoke]');
		process.exit(2);
	}
	const revoke = flag === '--revoke';

	const env = loadEnv(
		v.pick(Env, ['DATABASE_URL', 'FGA_API_URL', 'FGA_STORE_ID', 'FGA_MODEL_ID', 'FGA_TIMEOUT_MS']),
		Bun.env,
	);
	const logger = createLogger({
		level: 'warn',
		service: 'akashic-admin-grant',
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
		const account = await grantPlatformAdmin({ db: database.db, authorizer, email, revoke });
		console.log(
			`platform administration ${revoke ? 'revoked from' : 'granted to'} ${account.name} <${email}>`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	} finally {
		await database[Symbol.asyncDispose]();
	}
}
