import { timingSafeEqual } from 'node:crypto';
import { and, asc, count, desc, eq, gt, or, sql } from 'drizzle-orm';
import type { DeviceKey, RoomSummary, UserDeviceKey } from '@akashic/contracts';
import {
	type Executor,
	jobs,
	listings,
	realmMembers,
	realms,
	rooms,
	user,
	userKeys,
} from '@akashic/db';
import { first, one } from '@akashic/db/sql';
import { RoomSubject } from '@akashic/lib/enums';
import {
	EventNotFound,
	MemberNotFound,
	NotBothMembers,
	RateLimited,
	RealmNotFound,
	ValidationFailed,
} from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import { policy } from '@/config.ts';
import type {
	KeysOfError,
	NewRoom,
	Opened,
	ParticipantError,
	Published,
	Room,
	RoomAccessDeps,
	StartError,
	StartRequest,
	Ticket,
	TicketClaim,
	TicketError,
	TicketOptions,
	Tickets,
} from './room.types.ts';

const limits = policy.rooms;
const INBOX_SIZE = 50;

// ---- Tickets ---------------------------------------------------------------------------------

/**
 * Short-lived tickets for one room's WebSocket. A WebSocket upgrade can't carry the session
 * cookie through the front end's proxy, so the page fetches a ticket over HTTP first.
 */
export function createTickets(options: TicketOptions): Tickets {
	const ttl = Temporal.Duration.from(options.ttl);
	const sign = (claim: string) =>
		new Bun.CryptoHasher('sha256', options.secret).update(claim).digest('hex');

	return {
		issue(roomId, userId, now) {
			const claim = `${roomId}:${userId}:${now.add(ttl).epochMilliseconds}`;
			return `${claim}:${sign(claim)}`;
		},

		read(ticket, now) {
			const parts = partsOf(ticket);
			if (!parts) return null;
			const { roomId, userId, expiresAt, signature } = parts;

			const expected = Buffer.from(sign(`${roomId}:${userId}:${expiresAt}`));
			const given = Buffer.from(signature);
			// Constant time, so the response time doesn't reveal how much of a guess was right.
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

			const deadline = Number(expiresAt);
			if (!Number.isFinite(deadline) || deadline < now.epochMilliseconds) return null;
			return { roomId, userId };
		},
	};
}

/** Exactly four non-empty fields, or nothing: a ticket with more is not one this issued. */
function partsOf(ticket: string) {
	const [roomId, userId, expiresAt, signature, ...rest] = ticket.split(':');
	if (!roomId || !userId || !expiresAt || !signature || rest.length > 0) return null;
	return { roomId, userId, expiresAt, signature };
}

// ---- Queries ---------------------------------------------------------------------------------

/** A pair stored in a fixed order, so either participant finds the same room. */
const ordered = (a: string, b: string) => (a < b ? { low: a, high: b } : { low: b, high: a });

/** Rooms `userId` is one of the two people in. */
const participantIn = (userId: string) =>
	or(eq(rooms.lowUserId, userId), eq(rooms.highUserId, userId));

/** The room, only when `userId` is one of its two participants. */
export async function findFor(
	db: Executor,
	roomId: string,
	userId: string,
): Promise<Room | undefined> {
	const row = first(
		await db
			.select({
				id: rooms.id,
				realmId: rooms.realmId,
				lowUserId: rooms.lowUserId,
				highUserId: rooms.highUserId,
			})
			.from(rooms)
			.where(and(eq(rooms.id, roomId), participantIn(userId)))
			.limit(1),
	);
	return row;
}

/**
 * The caller's room, or not found: a room someone is not in does not exist for them, so nobody
 * learns which rooms exist by asking.
 */
export async function participant(
	db: Executor,
	roomId: string,
	userId: string,
): Promise<Result<Room, ParticipantError>> {
	const room = await findFor(db, roomId, userId);
	return room ? ok(room) : err(new EventNotFound('No such room.'));
}

async function realmIdOf(db: Executor, slug: string): Promise<string | undefined> {
	const row = first(
		await db.select({ id: realms.id }).from(realms).where(eq(realms.slug, slug)).limit(1),
	);
	return row?.id;
}

async function isMember(db: Executor, realmId: string, userId: string): Promise<boolean> {
	const row = first(
		await db
			.select({ role: realmMembers.role })
			.from(realmMembers)
			.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)))
			.limit(1),
	);
	return row !== undefined;
}

/** Whether the job or listing a room would be about is posted in that realm. */
async function subjectIn(
	db: Executor,
	realmId: string,
	kind: RoomSubject,
	subjectId: string,
): Promise<boolean> {
	const table = kind === RoomSubject.job ? jobs : listings;
	const row = first(
		await db
			.select({ id: table.id })
			.from(table)
			.where(and(eq(table.id, subjectId), eq(table.realmId, realmId)))
			.limit(1),
	);
	return row !== undefined;
}

async function roomsOpenedSince(
	db: Executor,
	userId: string,
	since: Temporal.Instant,
): Promise<number> {
	const row = one(
		await db
			.select({ n: count() })
			.from(rooms)
			.where(and(participantIn(userId), gt(rooms.createdAt, toDate(since)))),
		'room count',
	);
	return row.n;
}

/** The existing room for this pair and posting, or a new one. */
async function open(db: Executor, room: NewRoom): Promise<string> {
	const { low, high } = ordered(room.a, room.b);
	const row = one(
		await db
			.insert(rooms)
			.values({
				realmId: room.realmId,
				subjectKind: room.subjectKind,
				subjectId: room.subjectId,
				lowUserId: low,
				highUserId: high,
			})
			.onConflictDoUpdate({
				target: [rooms.subjectKind, rooms.subjectId, rooms.lowUserId, rooms.highUserId],
				set: { realmId: room.realmId },
			})
			.returning({ id: rooms.id }),
		'room upsert',
	);
	return row.id;
}

async function inbox(db: Executor, userId: string, limit: number): Promise<RoomSummary[]> {
	const other = sql<string>`CASE WHEN ${rooms.lowUserId} = ${userId} THEN ${rooms.highUserId} ELSE ${rooms.lowUserId} END`;
	const rows = await db
		.select({
			id: rooms.id,
			realmId: rooms.realmId,
			subjectKind: rooms.subjectKind,
			subjectId: rooms.subjectId,
			lastMessageAt: rooms.lastMessageAt,
			createdAt: rooms.createdAt,
			otherId: other,
			otherName: user.name,
		})
		.from(rooms)
		.innerJoin(user, sql`${user.id} = ${other}`)
		.where(participantIn(userId))
		.orderBy(desc(rooms.lastMessageAt), desc(rooms.createdAt))
		.limit(limit);
	return rows.map((row) => ({
		...row,
		lastMessageAt: row.lastMessageAt && fromDate(row.lastMessageAt),
		createdAt: fromDate(row.createdAt),
	}));
}

// ---- Service ---------------------------------------------------------------------------------

/** Device keys, opening rooms, listing them, and the tickets sockets join with. */
export function createRoomService(deps: RoomAccessDeps) {
	const { db, clock, tickets } = deps;

	return {
		/** Adds or refreshes one device; a second browser is a second device, not a new identity. */
		async publishKey(userId: string, key: DeviceKey): Promise<Published> {
			await db
				.insert(userKeys)
				.values({ userId, ...key })
				.onConflictDoUpdate({
					target: [userKeys.userId, userKeys.fingerprint],
					set: {
						publicKey: key.publicKey,
						signingKey: key.signingKey,
						seenAt: toDate(clock.now()),
					},
				});
			return { published: true };
		},

		/** Every device someone reads on, oldest first. */
		async keysOf(userId: string): Promise<Result<UserDeviceKey[], KeysOfError>> {
			const keys = await db
				.select({
					publicKey: userKeys.publicKey,
					signingKey: userKeys.signingKey,
					fingerprint: userKeys.fingerprint,
				})
				.from(userKeys)
				.where(eq(userKeys.userId, userId))
				.orderBy(asc(userKeys.createdAt));
			if (keys.length === 0) {
				// realm.not_member is already on the wire here: a 404, as they have no keys yet.
				return err(
					new MemberNotFound(
						'That person has not set up encryption yet, so there is no key to send to.',
					),
				);
			}
			return ok(keys.map((key) => ({ userId, ...key })));
		},

		/** Opens (or reopens) a conversation about a posting between two members of its realm. */
		async start(userId: string, request: StartRequest): Promise<Result<Opened, StartError>> {
			if (request.withUserId === userId) {
				return err(new ValidationFailed('You cannot open a room with yourself.'));
			}
			const realmId = await realmIdOf(db, request.realmSlug);
			if (!realmId) return err(new RealmNotFound('No such realm.'));

			const [mine, theirs] = await Promise.all([
				isMember(db, realmId, userId),
				isMember(db, realmId, request.withUserId),
			]);
			if (!mine || !theirs) {
				return err(
					new NotBothMembers('Both people have to be in the realm the posting belongs to.'),
				);
			}
			// The realm is named in the body: the posting has to be in it, or a room in one realm
			// could be about another realm's posting.
			if (!(await subjectIn(db, realmId, request.subjectKind, request.subjectId))) {
				return err(new EventNotFound('No such posting in that realm.'));
			}

			const dayAgo = clock.now().subtract({ hours: 24 });
			if ((await roomsOpenedSince(db, userId, dayAgo)) >= limits.roomsPerDay) {
				return err(
					new RateLimited('That is a lot of new conversations for one day. Try again tomorrow.'),
				);
			}

			const id = await open(db, {
				realmId,
				subjectKind: request.subjectKind,
				subjectId: request.subjectId,
				a: userId,
				b: request.withUserId,
			});
			return ok({ id });
		},

		/** The caller's rooms, most recently active first. */
		inbox: (userId: string): Promise<RoomSummary[]> => inbox(db, userId, INBOX_SIZE),

		async ticket(roomId: string, userId: string): Promise<Result<Ticket, TicketError>> {
			const room = await participant(db, roomId, userId);
			if (!room.ok) return room;
			return ok({
				ticket: tickets.issue(roomId, userId, clock.now()),
				expiresInSeconds: limits.ticketTtlSeconds,
			});
		},

		/** Who a socket belongs to, or null when its ticket doesn't admit it to this room. */
		async admit(roomId: string, ticket: string): Promise<TicketClaim | null> {
			const claim = tickets.read(ticket, clock.now());
			if (!claim || claim.roomId !== roomId) return null;
			return (await findFor(db, roomId, claim.userId)) ? claim : null;
		},
	};
}
