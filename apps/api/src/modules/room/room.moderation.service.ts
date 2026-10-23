import { and, eq, sql } from 'drizzle-orm';
import {
	type Executor,
	inTransaction,
	roomBlocks,
	roomMessages,
	roomReports,
	rooms,
} from '@akashic/db';
import { EventNotFound, ValidationFailed } from '@akashic/lib/errors';
import { err, ok, type Result, value } from '@akashic/lib/result';
import { participant } from './room.service.ts';
import type {
	Agreement,
	Blocked,
	BlockError,
	MessageReport,
	Opened,
	ReportError,
	Retention,
	RetentionError,
	RetentionState,
	RoomAreaDeps,
} from './room.types.ts';

// ---- Rules -----------------------------------------------------------------------------------

/**
 * One participant proposing `days` of retention. Agreeing to the standing proposal adds to who
 * agreed; a different number starts over. It takes force once both participants have agreed.
 */
export function agreeOn(room: RetentionState, days: number | null, userId: string): Agreement {
	const agreed = new Set([...(room.days === days ? (room.agreedBy ?? []) : []), userId]);
	return { agreedBy: [...agreed], inForce: agreed.has(room.low) && agreed.has(room.high) };
}

// ---- Queries ---------------------------------------------------------------------------------

/** The sender of a message in the room, for a report. */
async function senderOf(
	db: Executor,
	roomId: string,
	messageId: string,
): Promise<string | undefined> {
	const [row] = await db
		.select({ senderId: roomMessages.senderId })
		.from(roomMessages)
		.where(and(eq(roomMessages.id, messageId), eq(roomMessages.roomId, roomId)))
		.limit(1);
	return row?.senderId;
}

/** Records the user's agreement to `days`; true once both participants agree. */
async function agreeRetention(
	db: Executor,
	roomId: string,
	userId: string,
	days: number | null,
): Promise<boolean> {
	return value(
		await inTransaction(db, async (tx) => {
			// Locked, so two people agreeing at once don't each overwrite the other's agreement.
			const [room] = await tx
				.select({
					days: rooms.retentionDays,
					agreedBy: rooms.retentionAgreedBy,
					low: rooms.lowUserId,
					high: rooms.highUserId,
				})
				.from(rooms)
				.where(eq(rooms.id, roomId))
				.for('update')
				.limit(1);
			if (!room) return ok(false);

			const { agreedBy, inForce } = agreeOn(room, days, userId);
			await tx
				.update(rooms)
				.set({ retentionDays: days, retentionAgreedBy: agreedBy })
				.where(eq(rooms.id, roomId));
			return ok(inForce);
		}),
	);
}

// ---- Service ---------------------------------------------------------------------------------

/** Closing a room, reporting a message, and how long messages are kept. */
export function createModerationService(deps: RoomAreaDeps) {
	const { db } = deps;

	return {
		async block(roomId: string, userId: string): Promise<Result<Blocked, BlockError>> {
			const room = await participant(db, roomId, userId);
			if (!room.ok) return room;
			await db.insert(roomBlocks).values({ roomId, blockerId: userId }).onConflictDoNothing();
			return ok({ blocked: true });
		},

		/** Lifts only the caller's own block; the other person's stays. */
		async unblock(roomId: string, userId: string): Promise<Result<Blocked, BlockError>> {
			const room = await participant(db, roomId, userId);
			if (!room.ok) return room;
			await db
				.delete(roomBlocks)
				.where(and(eq(roomBlocks.roomId, roomId), eq(roomBlocks.blockerId, userId)));
			return ok({ blocked: false });
		},

		async report(
			roomId: string,
			reporterId: string,
			report: MessageReport,
		): Promise<Result<Opened, ReportError>> {
			const room = await participant(db, roomId, reporterId);
			if (!room.ok) return room;
			const accusedId = await senderOf(db, roomId, report.messageId);
			if (!accusedId) {
				return err(new EventNotFound('No such message in this room.'));
			}
			if (accusedId === reporterId) {
				return err(new ValidationFailed('That message was sent by you.'));
			}

			const [created] = await db
				.insert(roomReports)
				.values({
					roomId,
					messageId: report.messageId,
					reporterId,
					accusedId,
					reason: report.reason,
					disclosedText: report.disclosedText,
				})
				.returning({ id: roomReports.id });
			if (!created) throw new Error('report insert returned no row');
			return ok({ id: created.id });
		},

		async setRetention(
			roomId: string,
			userId: string,
			days: number | null,
		): Promise<Result<Retention, RetentionError>> {
			const room = await participant(db, roomId, userId);
			if (!room.ok) return room;
			const inForce = await agreeRetention(db, roomId, userId, days);
			return ok({ days, inForce });
		},

		/** Deletes messages past a retention both participants agreed to; answers how many. */
		async sweepExpired(): Promise<number> {
			// A message goes when its room's retention is agreed by both participants and has run out.
			const removed = await db.execute<{ id: string }>(sql`
        DELETE FROM room_message m
        USING room r
        WHERE m.room_id = r.id
          AND r.retention_days IS NOT NULL
          AND r.low_user_id = ANY(r.retention_agreed_by)
          AND r.high_user_id = ANY(r.retention_agreed_by)
          AND m.created_at < now() - make_interval(days => r.retention_days)
        RETURNING m.id
      `);
			return removed.length;
		},
	};
}
