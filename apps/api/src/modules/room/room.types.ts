import type { SentMessage, WrappedKey } from '@akashic/contracts';
import type { Executor } from '@akashic/db';
import type { RoomSubject } from '@akashic/lib/enums';
import type {
	EventNotFound,
	MemberNotFound,
	NotBothMembers,
	RateLimited,
	RealmForbidden,
	RealmNotFound,
	ValidationFailed,
} from '@akashic/lib/errors';
import type { Logger } from '@akashic/lib/log';
import type { Clock } from '@akashic/lib/time';
import type { AppEnv } from '@/http/env.ts';
import type { Relay } from '@/integrations/relay.ts';
import type { createMessageService } from './room.messages.service.ts';
import type { createModerationService } from './room.moderation.service.ts';
import type { createRoomService } from './room.service.ts';

// ---- Dependencies ----------------------------------------------------------------------------

/** What the room services are built from. */
export interface RoomServicesDeps {
	db: Executor;
	clock: Clock;
	/** Signs socket tickets; the same secret as sessions, so rotating one rotates both. */
	ticketSecret: string;
}

/** What each room area is built from. */
export interface RoomAreaDeps {
	db: Executor;
	clock: Clock;
}

/** Opening rooms also issues and reads the tickets sockets join with. */
export interface RoomAccessDeps extends RoomAreaDeps {
	tickets: Tickets;
}

export type RoomService = ReturnType<typeof createRoomService>;
export type MessageService = ReturnType<typeof createMessageService>;
export type ModerationService = ReturnType<typeof createModerationService>;

/** Every room service, as the routes and the socket use them. */
export interface RoomServices {
	rooms: RoomService;
	messages: MessageService;
	moderation: ModerationService;
}

export interface RoomRoutesDeps {
	services: RoomServices;
	/** Carries socket messages to the other instances. */
	relay: Relay;
	logger: Logger;
}

export type RoomModuleDeps = RoomRoutesDeps;

/** A socket request once its ticket has admitted it. */
export interface SocketEnv extends AppEnv {
	Variables: AppEnv['Variables'] & { admitted: TicketClaim };
}

// ---- Tickets ---------------------------------------------------------------------------------

export interface TicketOptions {
	secret: string;
	ttl: Temporal.DurationLike;
}

/** Who a ticket admits, and to which room. */
export interface TicketClaim {
	roomId: string;
	userId: string;
}

export interface Tickets {
	issue(roomId: string, userId: string, now: Temporal.Instant): string;
	/** The ticket's room and user, or null when it is forged, malformed or expired. */
	read(ticket: string, now: Temporal.Instant): TicketClaim | null;
}

export interface Ticket {
	ticket: string;
	expiresInSeconds: number;
}

// ---- Rooms -----------------------------------------------------------------------------------

/** A room as its participants see it: the pair is stored ordered, low then high. */
export interface Room {
	id: string;
	realmId: string;
	lowUserId: string;
	highUserId: string;
}

/** A request to open a room about a posting with another member of its realm. */
export interface StartRequest {
	realmSlug: string;
	subjectKind: RoomSubject;
	subjectId: string;
	withUserId: string;
}

export interface NewRoom {
	realmId: string;
	subjectKind: RoomSubject;
	subjectId: string;
	a: string;
	b: string;
}

export interface Opened {
	id: string;
}

export interface Published {
	published: true;
}

// ---- Messages --------------------------------------------------------------------------------

export interface TranscriptOptions {
	after?: string | undefined;
	limit: number;
	/** The asking device, whose wrapped key comes back with each message. */
	device?: string | undefined;
}

/** A message as the sender hands it over: ciphertext and a key for each device. */
export interface OutgoingMessage {
	body: string;
	iv: string;
	signature?: string | undefined;
	keys: WrappedKey[];
}

/** The devices the sender has to fetch keys for and encrypt to; nothing was stored. */
export interface StaleDevices {
	staleDevices: string[];
}

export interface Delivered {
	sent: SentMessage;
}

/** The stored message, or the devices the sender missed. */
export type Sent = StaleDevices | Delivered;

/** The row `append` wrote. */
export interface Appended {
	id: string;
	createdAt: Temporal.Instant;
}

// ---- Moderation ------------------------------------------------------------------------------

export interface Blocked {
	blocked: boolean;
}

export interface MessageReport {
	messageId: string;
	reason: string;
	disclosedText?: string | undefined;
}

/** The days a participant asked for, and whether both have agreed to them. */
export interface Retention {
	days: number | null;
	inForce: boolean;
}

/** A room's standing retention proposal and who has agreed to it. */
export interface RetentionState {
	days: number | null;
	agreedBy: string[] | null;
	low: string;
	high: string;
}

export interface Agreement {
	agreedBy: string[];
	inForce: boolean;
}

// ---- Errors ----------------------------------------------------------------------------------

// What each room service call can fail with. A room someone isn't in is "no such room".
export type ParticipantError = EventNotFound;
export type KeysOfError = MemberNotFound;
export type StartError =
	| ValidationFailed
	| RealmNotFound
	| NotBothMembers
	| EventNotFound
	| RateLimited;
export type TicketError = ParticipantError;
export type TranscriptError = ParticipantError;
export type AppendError = never;
export type SendError = ParticipantError | RealmForbidden | RateLimited | AppendError;
export type AgreeRetentionError = never;
export type BlockError = ParticipantError;
export type ReportError = ParticipantError | ValidationFailed;
export type RetentionError = ParticipantError | AgreeRetentionError;
