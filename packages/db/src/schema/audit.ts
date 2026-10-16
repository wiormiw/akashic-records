import { index, pgTable, smallint, text, uuid } from 'drizzle-orm/pg-core';
import { json, primaryId, utcTimestamp } from './columns.ts';

/** Who changed what. Written in the same transaction as the change. */
export const auditEntries = pgTable(
	'audit_entries',
	{
		id: primaryId(),
		// Null for changes the system made on its own.
		userId: uuid('user_id'),
		entityType: text('entity_type').notNull(),
		entityId: uuid('entity_id').notNull(),
		action: smallint('action').notNull(),
		changes: json<Record<string, unknown>>('changes'),
		traceId: text('trace_id'),
		occurredAt: utcTimestamp('occurred_at').notNull().defaultNow(),
	},
	(table) => [
		index('ix_audit_entity').on(table.entityType, table.entityId, table.occurredAt.desc()),
	],
);
