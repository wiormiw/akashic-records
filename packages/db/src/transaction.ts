import type { Attributes } from '@opentelemetry/api';
import type { Result } from '@akashic/lib/result';
import { traced } from '@akashic/lib/tracing';
import type { Executor, Tx } from './client.ts';

/** Carries a returned `err` out of Drizzle's callback; never leaves this file. */
class Rollback<T> extends Error {
	constructor(readonly result: Result<T>) {
		super('rolled back');
	}
}

/**
 * Runs `work` in one transaction: commits on `ok`, rolls back on `err` or a throw, so a failure
 * found halfway never commits the half already written, nor its events. Given a transaction, it
 * opens a savepoint, so a service called inside another's transaction (or a test's) still rolls
 * back only its own part.
 */
export function inTransaction<T>(
	db: Executor,
	work: (tx: Tx) => Promise<Result<T>>,
	attributes: Attributes = {},
): Promise<Result<T>> {
	return traced('db.transaction', { 'db.system.name': 'postgresql', ...attributes }, async () => {
		try {
			return await db.transaction(async (tx) => {
				const result = await work(tx);
				// Drizzle rolls back only on a throw.
				if (!result.ok) throw new Rollback(result);
				return result;
			});
		} catch (error) {
			if (error instanceof Rollback) return error.result as Result<T>;
			throw error;
		}
	});
}
