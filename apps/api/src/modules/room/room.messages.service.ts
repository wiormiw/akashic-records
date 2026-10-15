import { and, asc, count, eq, gt, inArray } from "drizzle-orm";
import type { StoredMessage } from "@akashic/contracts";
import {
  type Executor,
  inTransaction,
  roomBlocks,
  roomMessageKeys,
  roomMessages,
  rooms,
  userKeys,
} from "@akashic/db";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { fromDate, toDate } from "@akashic/lib/time";
import { policy } from "@/config.ts";
import { participant } from "./room.service.ts";
import type {
  Appended,
  OutgoingMessage,
  RoomAreaDeps,
  Sent,
  TranscriptOptions,
} from "./room.types.ts";

const limits = policy.rooms;

// ---- Queries ---------------------------------------------------------------------------------

/** One page of a room's messages, each with the key wrapped for `device`, if it has one. */
async function messagesOf(
  db: Executor,
  roomId: string,
  options: TranscriptOptions,
): Promise<StoredMessage[]> {
  const { after, limit, device } = options;
  const rows = await db
    .select({
      id: roomMessages.id,
      senderId: roomMessages.senderId,
      body: roomMessages.body,
      iv: roomMessages.iv,
      signature: roomMessages.signature,
      createdAt: roomMessages.createdAt,
      wrappedKey: roomMessageKeys.wrappedKey,
      keyIv: roomMessageKeys.iv,
    })
    .from(roomMessages)
    .leftJoin(
      roomMessageKeys,
      and(
        eq(roomMessageKeys.messageId, roomMessages.id),
        eq(roomMessageKeys.fingerprint, device ?? ""),
      ),
    )
    .where(and(eq(roomMessages.roomId, roomId), after ? gt(roomMessages.id, after) : undefined))
    .orderBy(asc(roomMessages.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, createdAt: fromDate(row.createdAt) }));
}

async function isBlocked(db: Executor, roomId: string): Promise<boolean> {
  const [row] = await db
    .select({ roomId: roomBlocks.roomId })
    .from(roomBlocks)
    .where(eq(roomBlocks.roomId, roomId))
    .limit(1);
  return row !== undefined;
}

async function messagesSentSince(
  db: Executor,
  roomId: string,
  senderId: string,
  since: Temporal.Instant,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(roomMessages)
    .where(
      and(
        eq(roomMessages.roomId, roomId),
        eq(roomMessages.senderId, senderId),
        gt(roomMessages.createdAt, toDate(since)),
      ),
    );
  return row?.n ?? 0;
}

/** Every device of these people. */
async function fingerprintsOf(db: Executor, userIds: readonly string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({ fingerprint: userKeys.fingerprint })
    .from(userKeys)
    .where(inArray(userKeys.userId, [...userIds]));
  return rows.map((row) => row.fingerprint);
}

/** The message, its keys and the room's recency land together or not at all. */
function append(
  db: Executor,
  roomId: string,
  senderId: string,
  message: OutgoingMessage,
): Promise<Result<Appended>> {
  const { keys, body, iv, signature } = message;
  return inTransaction(db, async (tx) => {
    const [stored] = await tx
      .insert(roomMessages)
      .values({ roomId, senderId, body, iv, signature })
      .returning({ id: roomMessages.id, createdAt: roomMessages.createdAt });
    if (!stored) throw new Error("message insert returned no row");

    if (keys.length > 0) {
      await tx.insert(roomMessageKeys).values(
        keys.map((key) => ({
          messageId: stored.id,
          fingerprint: key.fingerprint,
          wrappedKey: key.wrappedKey,
          iv: key.iv,
        })),
      );
    }
    await tx.update(rooms).set({ lastMessageAt: stored.createdAt }).where(eq(rooms.id, roomId));
    return ok({ id: stored.id, createdAt: fromDate(stored.createdAt) });
  });
}

// ---- Service ---------------------------------------------------------------------------------

/** Reading a room's messages and sending one into it. */
export function createMessageService(deps: RoomAreaDeps) {
  const { db, clock } = deps;

  return {
    async transcript(
      roomId: string,
      userId: string,
      options: TranscriptOptions,
    ): Promise<Result<StoredMessage[]>> {
      const room = await participant(db, roomId, userId);
      return room.ok ? ok(await messagesOf(db, roomId, options)) : room;
    },

    /**
     * Stores a message if the room is open, the sender isn't flooding it, and the message is
     * encrypted for every device of both participants.
     */
    async send(roomId: string, senderId: string, message: OutgoingMessage): Promise<Result<Sent>> {
      const found = await participant(db, roomId, senderId);
      if (!found.ok) return found;
      const room = found.value;
      if (await isBlocked(db, roomId)) {
        return err(fail.forbidden(ErrorCode.realm.forbidden, "This conversation has been closed."));
      }

      const minuteAgo = clock.now().subtract({ minutes: 1 });
      if ((await messagesSentSince(db, roomId, senderId, minuteAgo)) >= limits.messagesPerMinute) {
        return err(fail.rateLimited(ErrorCode.common.rateLimited, "Slow down a moment."));
      }

      // A device added since the sender last fetched keys would get a message it can't read.
      const devices = await fingerprintsOf(db, [room.lowUserId, room.highUserId]);
      const addressed = new Set(message.keys.map((key) => key.fingerprint));
      if (devices.some((fingerprint) => !addressed.has(fingerprint))) {
        return ok({ staleDevices: devices });
      }

      const stored = await append(db, roomId, senderId, message);
      if (!stored.ok) return stored;
      const { body, iv, signature, keys } = message;
      return ok({ sent: { body, iv, signature, keys, ...stored.value, senderId } });
    },
  };
}
