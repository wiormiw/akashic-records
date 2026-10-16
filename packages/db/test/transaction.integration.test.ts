import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { AuditAction } from '@akashic/lib/enums';
import { ErrorCode, fail } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { err, ok } from '@akashic/lib/result';
import { audit, auditEntries, createDb, inTransaction, outboxMessages, publish } from '@akashic/db';

const url = Bun.env.DATABASE_URL ?? 'postgres://akashic:akashic@localhost:5432/akashic';
const database = createDb({
	url,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());
const now = Temporal.Instant.from('2026-06-01T12:00:00Z');

describe.skipIf(!live)('inTransaction', () => {
	test('a returned err rolls back rows and events written before it', async () => {
		const entityId = Bun.randomUUIDv7();
		const result = await inTransaction(database.db, async (tx) => {
			await publish(tx, [{ type: 'test.rolled_back', payload: { entityId } }], now);
			await audit(tx, { actorId: null, entityType: 'test', entityId, action: AuditAction.created });
			return err(fail.conflict(ErrorCode.realm.duplicateSlug, 'Taken.'));
		});
		expect(result.ok).toBe(false);
		expect(
			await database.db.select().from(auditEntries).where(eq(auditEntries.entityId, entityId)),
		).toEqual([]);
		const events = await database.db
			.select()
			.from(outboxMessages)
			.where(eq(outboxMessages.messageType, 'test.rolled_back'));
		expect(events.filter((e) => (e.payload as { entityId: string }).entityId === entityId)).toEqual(
			[],
		);
	});

	test('an ok commits, and jsonb is stored as an object, not a string', async () => {
		const entityId = Bun.randomUUIDv7();
		const result = await inTransaction(database.db, async (tx) => {
			await publish(tx, [{ type: 'test.committed', payload: { entityId } }], now);
			return ok(entityId);
		});
		expect(result).toEqual(ok(entityId));
		const [row] = await database.sql`
      SELECT jsonb_typeof(payload) AS kind FROM outbox_messages
      WHERE message_type = 'test.committed' AND payload->>'entityId' = ${entityId}`;
		expect(row.kind).toBe('object');
		await database.sql`DELETE FROM outbox_messages WHERE payload->>'entityId' = ${entityId}`;
	});
});
