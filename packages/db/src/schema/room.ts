import { index, pgTable, primaryKey, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.ts';
import { cascadeTo, createdAt, primaryId, utcTimestamp } from './columns.ts';
import { realms } from './realm.ts';

// End-to-end encrypted rooms: the server stores ciphertext and wrapped keys, never plaintext.

/** A device's public keys. One user has one row per device (fingerprint). */
export const userKeys = pgTable(
	'user_key',
	{
		userId: cascadeTo('user_id', () => user.id),
		publicKey: text('public_key').notNull(),
		signingKey: text('signing_key'),
		fingerprint: text('fingerprint').notNull(),
		seenAt: utcTimestamp('seen_at').notNull().defaultNow(),
		createdAt: createdAt(),
	},
	(table) => [
		primaryKey({ columns: [table.userId, table.fingerprint] }),
		index('ix_user_key_user').on(table.userId, table.seenAt),
	],
);

/** A conversation between two people about one posting. */
export const rooms = pgTable(
	'room',
	{
		id: primaryId(),
		realmId: cascadeTo('realm_id', () => realms.id),
		subjectKind: smallint('subject_kind').notNull(),
		subjectId: uuid('subject_id').notNull(),
		// The pair is stored ordered, so (a, b) and (b, a) are the same room.
		lowUserId: cascadeTo('low_user_id', () => user.id),
		highUserId: cascadeTo('high_user_id', () => user.id),
		createdAt: createdAt(),
		lastMessageAt: utcTimestamp('last_message_at'),
		// Applies only once both participants have agreed to it.
		retentionDays: smallint('retention_days'),
		retentionAgreedBy: uuid('retention_agreed_by').array(),
	},
	(table) => [
		uniqueIndex('ux_room_pair_subject').on(
			table.subjectKind,
			table.subjectId,
			table.lowUserId,
			table.highUserId,
		),
		index('ix_room_low_recent').on(table.lowUserId, table.lastMessageAt),
		index('ix_room_high_recent').on(table.highUserId, table.lastMessageAt),
	],
);

export const roomMessages = pgTable(
	'room_message',
	{
		id: primaryId(),
		roomId: cascadeTo('room_id', () => rooms.id),
		senderId: cascadeTo('sender_id', () => user.id),
		body: text('body').notNull(),
		iv: text('iv').notNull(),
		signature: text('signature'),
		createdAt: createdAt(),
	},
	(table) => [index('ix_room_message_room').on(table.roomId, table.id)],
);

/** The message key, wrapped once per recipient device. */
export const roomMessageKeys = pgTable(
	'room_message_key',
	{
		messageId: cascadeTo('message_id', () => roomMessages.id),
		fingerprint: text('fingerprint').notNull(),
		wrappedKey: text('wrapped_key').notNull(),
		iv: text('iv').notNull(),
	},
	(table) => [primaryKey({ columns: [table.messageId, table.fingerprint] })],
);

export const roomBlocks = pgTable(
	'room_block',
	{
		roomId: cascadeTo('room_id', () => rooms.id),
		blockerId: cascadeTo('blocker_id', () => user.id),
		createdAt: createdAt(),
	},
	(table) => [primaryKey({ columns: [table.roomId, table.blockerId] })],
);

/** A report. The reporter may disclose the plaintext, since the server can't read it. */
export const roomReports = pgTable(
	'room_report',
	{
		id: primaryId(),
		roomId: cascadeTo('room_id', () => rooms.id),
		messageId: uuid('message_id').references(() => roomMessages.id, { onDelete: 'set null' }),
		reporterId: cascadeTo('reporter_id', () => user.id),
		accusedId: cascadeTo('accused_id', () => user.id),
		reason: text('reason').notNull(),
		disclosedText: text('disclosed_text'),
		reviewedAt: utcTimestamp('reviewed_at'),
		createdAt: createdAt(),
	},
	(table) => [index('ix_room_report_open').on(table.reviewedAt, table.createdAt)],
);
