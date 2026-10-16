import { expect, test } from 'bun:test';
import { DuplicateSlug, RealmNotFound } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { assertTrue, type Equal } from '@akashic/lib/testing';
import { type Executor, inTransaction } from '@akashic/db';

test('a callback returning several error classes infers their union', () => {
	// Never called: only its type is checked, so no database is needed.
	const run = (db: Executor, pick: number) =>
		inTransaction(db, async () => {
			if (pick === 0) return err(new DuplicateSlug());
			if (pick === 1) return err(new RealmNotFound());
			return ok(1);
		});
	assertTrue<
		Equal<Awaited<ReturnType<typeof run>>, Result<number, DuplicateSlug | RealmNotFound>>
	>();
	expect(typeof run).toBe('function');
});
