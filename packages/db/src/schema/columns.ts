import { type AnyPgColumn, customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Case-insensitive text: uniqueness and equality ignore case without a lower() index. */
export const citext = customType<{ data: string }>({ dataType: () => 'citext' });

/** UUIDv7, generated in-process. Time-ordered, so `ORDER BY id` is insertion order. */
export const primaryId = () =>
	uuid('id')
		.primaryKey()
		.$defaultFn(() => Bun.randomUUIDv7());

/** timestamptz as a Date. Repositories convert to Temporal.Instant on read. */
export const utcTimestamp = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * jsonb bound as a value. Drizzle's own `jsonb` stringifies first, and bun:sql then stores the
 * string as a JSON string scalar instead of an object.
 */
export const json = <T = unknown>(name: string) =>
	customType<{ data: T; driverData: unknown }>({
		dataType: () => 'jsonb',
		toDriver: (value: T) => value,
		fromDriver: (value: unknown) =>
			typeof value === 'string' ? (JSON.parse(value) as T) : (value as T),
	})(name);

/** A required reference whose row goes when its target does. */
export const cascadeTo = (name: string, target: () => AnyPgColumn) =>
	uuid(name).notNull().references(target, { onDelete: 'cascade' });

/** When the row was written, stamped by the database. */
export const createdAt = () => utcTimestamp('created_at').notNull().defaultNow();

export const updatedAt = () => utcTimestamp('updated_at').notNull().defaultNow();
