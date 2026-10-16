import * as v from 'valibot';
import { narrow, RoomSubject } from '@akashic/lib/enums';
import { iso, isoOrNull, oneOf, queryInt, Timestamp, Uuid } from './common.ts';

// The rooms API contract. The server only ever holds ciphertext and wrapped keys, so that is all
// any of these carry. (Services hold a Temporal.Instant; the presenters render it.)

/** What one socket frame may carry. The API's policy reads these, so both sides agree. */
export const RoomFrameLimits = { maxMessageBytes: 8192, maxDevicesPerMessage: 24 } as const;

// ---- Requests --------------------------------------------------------------------------------

const fingerprint = v.pipe(v.string(), v.minLength(8), v.maxLength(128));
const key = v.pipe(v.string(), v.minLength(32), v.maxLength(2000));
const keyIv = v.pipe(v.string(), v.minLength(8), v.maxLength(64));

export const PublishKeyBody = v.object({ publicKey: key, signingKey: key, fingerprint });
export const UserParam = v.object({ userId: Uuid });
export const StartRoomBody = v.object({
	// The old API's pattern, kept as it was: case-insensitive, unlike a realm's own slug rule.
	realmSlug: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9-]{2,48}$/)),
	subjectKind: oneOf(RoomSubject),
	subjectId: Uuid,
	withUserId: Uuid,
});
export const TranscriptQuery = v.object({
	after: v.optional(Uuid),
	device: v.optional(fingerprint),
	limit: queryInt(1, 200, 100),
});
export const RetentionBody = v.object({
	days: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3650))),
});
export const ReportBody = v.object({
	messageId: Uuid,
	reason: v.pipe(v.string(), v.minLength(3), v.maxLength(500)),
	disclosedText: v.optional(v.pipe(v.string(), v.maxLength(8000))),
});

/** A frame a client sends over the room socket. */
export const SendMessageBody = v.object({
	body: v.pipe(v.string(), v.minLength(1), v.maxLength(RoomFrameLimits.maxMessageBytes)),
	iv: keyIv,
	signature: v.optional(v.pipe(v.string(), v.minLength(16), v.maxLength(512))),
	device: fingerprint,
	keys: v.pipe(
		v.array(
			v.object({
				fingerprint,
				wrappedKey: v.pipe(v.string(), v.minLength(16), v.maxLength(512)),
				iv: keyIv,
			}),
		),
		v.minLength(1),
		v.maxLength(RoomFrameLimits.maxDevicesPerMessage),
	),
});
export type SendMessageFrame = v.InferOutput<typeof SendMessageBody>;

// ---- What the services hold ------------------------------------------------------------------

/** One device's public keys. `signingKey` is null for keys published before signing existed. */
export interface DeviceKey {
	publicKey: string;
	signingKey: string | null;
	fingerprint: string;
}

/** A device key and whose it is. */
export interface UserDeviceKey extends DeviceKey {
	userId: string;
}

/** One room in someone's inbox, seen from their side. */
export interface RoomSummary {
	id: string;
	realmId: string;
	subjectKind: number;
	subjectId: string;
	otherId: string;
	otherName: string;
	lastMessageAt: Temporal.Instant | null;
	createdAt: Temporal.Instant;
}

/** A stored message as one device sees it: with the key wrapped for that device, if any. */
export interface StoredMessage {
	id: string;
	senderId: string;
	body: string;
	iv: string;
	signature: string | null;
	createdAt: Temporal.Instant;
	wrappedKey: string | null;
	keyIv: string | null;
}

/** The message key wrapped for one device. */
export interface WrappedKey {
	fingerprint: string;
	wrappedKey: string;
	iv: string;
}

/** A message just stored, with every device's envelope, as the socket announces it. */
export interface SentMessage {
	id: string;
	senderId: string;
	body: string;
	iv: string;
	signature?: string | undefined;
	keys: WrappedKey[];
	createdAt: Temporal.Instant;
}

// ---- Responses -------------------------------------------------------------------------------

const Integer = v.pipe(v.number(), v.integer());

export const PublishedView = v.object({ published: v.literal(true) });
export const DeviceKeyView = v.object({
	userId: v.string(),
	publicKey: v.string(),
	signingKey: v.nullable(v.string()),
	fingerprint: v.string(),
});
export const RoomSummaryView = v.object({
	id: v.string(),
	realmId: v.string(),
	subjectKind: oneOf(RoomSubject),
	subjectId: v.string(),
	otherId: v.string(),
	otherName: v.string(),
	lastMessageAt: v.nullable(Timestamp),
	createdAt: Timestamp,
});
export const MessageView = v.object({
	id: v.string(),
	senderId: v.string(),
	body: v.string(),
	iv: v.string(),
	signature: v.nullable(v.string()),
	createdAt: Timestamp,
	/** The message key wrapped for the asking device; null when it has none. */
	wrappedKey: v.nullable(v.string()),
	keyIv: v.nullable(v.string()),
});
export const TicketView = v.object({ ticket: v.string(), expiresInSeconds: Integer });
export const BlockedView = v.object({ blocked: v.boolean() });
export const RetentionView = v.object({ days: v.nullable(Integer), inForce: v.boolean() });

const WrappedKeyView = v.object({
	fingerprint: v.string(),
	wrappedKey: v.string(),
	iv: v.string(),
});

/**
 * What the socket sends everyone in the room when a message is stored. One frame goes to both
 * people, so it carries every device's envelope and none picked out for the reader.
 */
export const MessageFrameView = v.object({
	type: v.literal('message'),
	message: v.object({ ...MessageView.entries, keys: v.array(WrappedKeyView) }),
});
/** The devices a sender has to encrypt to before the message is accepted. */
export const StaleDevicesFrameView = v.object({
	type: v.literal('stale_devices'),
	devices: v.array(v.string()),
});
/** What went wrong with a frame, in words fit to show the sender. */
export const ErrorFrameView = v.object({ type: v.literal('error'), detail: v.string() });

// ---- Presenters ------------------------------------------------------------------------------

export const presentDeviceKey = (k: UserDeviceKey): v.InferOutput<typeof DeviceKeyView> => ({
	userId: k.userId,
	publicKey: k.publicKey,
	signingKey: k.signingKey,
	fingerprint: k.fingerprint,
});

export const presentRoomSummary = (r: RoomSummary): v.InferOutput<typeof RoomSummaryView> => ({
	id: r.id,
	realmId: r.realmId,
	subjectKind: narrow(RoomSubject, r.subjectKind),
	subjectId: r.subjectId,
	otherId: r.otherId,
	otherName: r.otherName,
	lastMessageAt: isoOrNull(r.lastMessageAt),
	createdAt: iso(r.createdAt),
});

export const presentMessage = (m: StoredMessage): v.InferOutput<typeof MessageView> => ({
	id: m.id,
	senderId: m.senderId,
	body: m.body,
	iv: m.iv,
	signature: m.signature,
	createdAt: iso(m.createdAt),
	wrappedKey: m.wrappedKey,
	keyIv: m.keyIv,
});

/** A stored message as the socket announces it: nobody's key is picked out. */
export const presentMessageFrame = (m: SentMessage): v.InferOutput<typeof MessageFrameView> => ({
	type: 'message',
	message: {
		id: m.id,
		senderId: m.senderId,
		body: m.body,
		iv: m.iv,
		signature: m.signature ?? null,
		createdAt: iso(m.createdAt),
		wrappedKey: null,
		keyIv: null,
		keys: m.keys.map((k) => ({ fingerprint: k.fingerprint, wrappedKey: k.wrappedKey, iv: k.iv })),
	},
});
