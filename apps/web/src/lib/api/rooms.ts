import * as v from 'valibot';
import {
	Created,
	DeviceKeyView,
	ErrorFrameView,
	MessageFrameView,
	MessageView,
	RoomSummaryView,
	StaleDevicesFrameView,
	TicketView,
} from '@akashic/contracts';
import type { RoomSubject } from '@akashic/lib/enums';
import { exportPublic, loadKeyring, type Keyring } from '$lib/crypto/keys';
import { open, seal, verify } from '$lib/crypto/messages';
import { API_BASE } from '$lib/config';

/**
 * Private rooms, from the browser's side.
 *
 * The server is a relay for bytes it cannot read, so everything meaningful happens here: keys are
 * generated and kept locally, the shared secret is derived per conversation, and a message is
 * sealed before it leaves and opened after it arrives.
 */

/** Somebody's published keys. `signingKey` is null for keys published before signing existed. */
export const PublicKeys = DeviceKeyView;
export type PublicKeys = v.InferOutput<typeof DeviceKeyView>;

/** One room in the inbox. */
export const RoomSummary = RoomSummaryView;
export type RoomSummary = v.InferOutput<typeof RoomSummaryView>;

/** One stored message, still sealed, as the transcript returns it for the asking device. */
export const StoredMessage = MessageView;
export type StoredMessage = v.InferOutput<typeof MessageView>;

/**
 * What the socket sends when a message is stored. It carries every device's envelope, which the
 * transcript does not: that addresses the asking device directly.
 */
export const LiveFrame = MessageFrameView;
export type LiveFrame = v.InferOutput<typeof MessageFrameView>;

/** The message inside a live frame. */
export const LiveMessage = MessageFrameView.entries.message;
export type LiveMessage = LiveFrame['message'];

/** Every frame the socket can carry; the page parses each one with this, never a cast. */
export const ServerFrame = v.variant('type', [
	MessageFrameView,
	StaleDevicesFrameView,
	ErrorFrameView,
]);
export type ServerFrame = v.InferOutput<typeof ServerFrame>;

/** A message after the browser has opened it. */
export interface ReadMessage {
	id: string;
	senderId: string;
	createdAt: string;
	/** Null when it will not open — tampered with, or not addressed to this device. */
	text: string | null;
	/**
	 * True when this device was not among the message's recipients — it did not exist yet.
	 *
	 * Different from a message that will not open: nothing is wrong, this browser simply was not
	 * around, and the reader is told that rather than shown a failure.
	 */
	predatesDevice: boolean;
	/**
	 * Whether the signature checks out against the sender's published key.
	 *
	 * `unsigned` is its own state, not a failure: messages written before signing existed are
	 * genuine and unprovable, and showing them as "unverified" would be as wrong as showing them
	 * as verified.
	 */
	authenticity: 'verified' | 'unsigned' | 'failed';
}

/**
 * Calls the room API through the BFF.
 *
 * @param path Path under `/bff/api/v1/rooms`.
 * @param init Method and body.
 * @param schema Parser for the response, when one is expected.
 * @returns The parsed body, or undefined.
 * @throws {Error} With the API's own message.
 *
 * @example
 * const rooms = await call('', {}, v.array(RoomSummary));
 */
async function call<TSchema extends v.GenericSchema>(
	path: string,
	init: RequestInit = {},
	schema?: TSchema,
): Promise<v.InferOutput<TSchema> | undefined> {
	const response = await fetch(`/bff/api/v1/rooms${path}`, {
		...init,
		headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers },
	});

	// 404 is an answer, not a fault: a person with no published keys, a room that is not the
	// caller's. Every caller here decides what absence means for itself.
	if (response.status === 404) return undefined;

	if (!response.ok) {
		const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
		throw new Error(problem?.detail ?? 'That did not work.');
	}

	if (!schema) return undefined;

	const parsed = v.safeParse(schema, await response.json());
	if (!parsed.success) throw new Error('The API answered in an unexpected shape.');

	return parsed.output;
}

/**
 * Registers this browser as one of the reader's devices.
 *
 * Published on every load rather than once, and additive rather than replacing: a second browser
 * is a second device, not a new identity. An earlier version replaced the person's key here,
 * which meant opening the app anywhere else made every message already sent unreadable — on both
 * sides, permanently.
 *
 * @returns This browser's keyring and the fingerprint that identifies it.
 *
 * @example
 * const { keyring, fingerprint } = await ensurePublished();
 */
export async function ensurePublished(): Promise<{ keyring: Keyring; fingerprint: string }> {
	const keyring = await loadKeyring();
	const published = await exportPublic(keyring);

	await call('/keys/me', { method: 'PUT', body: JSON.stringify(published) });

	return { keyring, fingerprint: published.fingerprint };
}

/**
 * Reads the caller's rooms.
 *
 * @returns Rooms, most recently active first.
 *
 * @example
 * const inbox = await listRooms();
 */
export async function listRooms(): Promise<RoomSummary[]> {
	return (await call('', {}, v.array(RoomSummary))) ?? [];
}

/**
 * Opens the room about a posting, or finds the existing one.
 *
 * @param realmSlug The realm the posting lives in.
 * @param subjectKind 0 for a job, 1 for a listing.
 * @param subjectId The posting.
 * @param withUserId The other person.
 * @returns The room id.
 *
 * @example
 * const { id } = await openRoom('weaboo', 1, listingId, sellerId);
 */
export async function openRoom(
	realmSlug: string,
	subjectKind: RoomSubject,
	subjectId: string,
	withUserId: string,
): Promise<{ id: string }> {
	const created = await call(
		'',
		{ method: 'POST', body: JSON.stringify({ realmSlug, subjectKind, subjectId, withUserId }) },
		Created,
	);

	if (!created) throw new Error('Could not open that conversation.');
	return created;
}

/**
 * Reads every device somebody reads on.
 *
 * An empty list is an ordinary answer, not a failure: a device appears the first time somebody
 * opens the app on it, so a room can legitimately exist before the other side has any. Nothing
 * can be written to them until then.
 *
 * @param userId Whose devices.
 * @returns Every device they read on, oldest first. Empty when they have never opened the app.
 *
 * @example
 * const theirs = await keysOf(room.otherId);
 * if (theirs.length === 0) waitForThem();
 */
export async function keysOf(userId: string): Promise<PublicKeys[]> {
	return (await call(`/keys/${userId}`, {}, v.array(PublicKeys))) ?? [];
}

/**
 * Reads a transcript and opens every message in it.
 *
 * Decryption and verification happen per message rather than per transcript, so one unreadable
 * message shows as unreadable instead of blanking the conversation around it.
 *
 * @param roomId The room.
 * @param keyring This browser's keys.
 * @param fingerprint This device, so the server sends back the envelope it can open.
 * @param devices Every device in the conversation, for unwrapping and for signatures.
 * @returns Messages oldest first, opened where possible.
 *
 * @example
 * const thread = await readTranscript(roomId, keyring, fingerprint, devices);
 */
export async function readTranscript(
	roomId: string,
	keyring: Keyring,
	fingerprint: string,
	devices: PublicKeys[],
): Promise<ReadMessage[]> {
	const stored =
		(await call(
			`/${roomId}/messages?device=${encodeURIComponent(fingerprint)}`,
			{},
			v.array(StoredMessage),
		)) ?? [];

	return Promise.all(stored.map((message) => decode(message, keyring, devices, fingerprint)));
}

/**
 * Opens one stored message and checks who wrote it.
 *
 * The wrap was made under the secret between the sending device and this one, so opening it means
 * trying the sender's devices — usually one, and at most a handful.
 *
 * @param message The sealed message, with the envelope for this device or all of them.
 * @param keyring This browser's keys.
 * @param devices Every device in the conversation.
 * @param fingerprint This device, for picking its envelope out of a live frame.
 * @returns The message as the UI needs it.
 *
 * @example
 * const read = await decode(stored, keyring, devices, fingerprint);
 */
export async function decode(
	message: StoredMessage | LiveMessage,
	keyring: Keyring,
	devices: PublicKeys[],
	fingerprint: string,
): Promise<ReadMessage> {
	const base = {
		id: message.id,
		senderId: message.senderId,
		createdAt: message.createdAt,
	};

	// A live frame carries every device's envelope, because one frame is published to both people.
	// A transcript row carries only this device's, already chosen by the query.
	const own = ('keys' in message ? message.keys : undefined)?.find(
		(key) => key.fingerprint === fingerprint,
	);
	const wrappedKey = own?.wrappedKey ?? message.wrappedKey;
	const keyIv = own?.iv ?? message.keyIv;

	// No envelope for this device: it was not around when the message was sent, and no key
	// anywhere can change that.
	if (!wrappedKey || !keyIv) {
		return { ...base, text: null, predatesDevice: true, authenticity: 'unsigned' };
	}

	const senders = devices.filter((device) => device.userId === message.senderId);
	let text: string | null = null;
	let sender: PublicKeys | undefined;

	for (const candidate of senders) {
		text = await open(keyring, candidate.publicKey, {
			body: message.body,
			iv: message.iv,
			wrappedKey,
			keyIv,
		});

		if (text !== null) {
			sender = candidate;
			break;
		}
	}

	let authenticity: ReadMessage['authenticity'] = 'unsigned';

	if (message.signature && sender?.signingKey && text !== null) {
		authenticity = (await verify(sender.signingKey, text, message.signature))
			? 'verified'
			: 'failed';
	}

	return { ...base, text, predatesDevice: false, authenticity };
}

/**
 * Buys a ticket and opens the socket.
 *
 * @param roomId The room.
 * @returns A connected socket.
 * @throws {Error} When the ticket is refused, which means the room is not the caller's.
 *
 * @example
 * const socket = await connect(roomId);
 */
export async function connect(roomId: string): Promise<WebSocket> {
	const issued = await call(`/${roomId}/ticket`, { method: 'POST' }, TicketView);

	if (!issued) throw new Error('Could not join that conversation.');

	// The socket talks to the API directly; only the ticket authorises it, so no cookie is needed
	// and the BFF is not in the path. `ws` behind plain http, `wss` behind https, from whatever
	// origin the API actually lives at.
	const base = API_BASE.replace(/^http/u, 'ws');

	return new WebSocket(`${base}/ws/rooms/${roomId}?ticket=${encodeURIComponent(issued.ticket)}`);
}

/**
 * Seals a message for every device in the conversation and sends it.
 *
 * Both people's devices, this browser included. The server refuses a message that misses one,
 * because it would arrive unreadable there and stay that way.
 *
 * @param socket The open socket.
 * @param keyring This browser's keys.
 * @param fingerprint This device.
 * @param devices Every device that may read it.
 * @param text What to say.
 *
 * @example
 * await send(socket, keyring, fingerprint, devices, 'Still available?');
 */
export async function send(
	socket: WebSocket,
	keyring: Keyring,
	fingerprint: string,
	devices: PublicKeys[],
	text: string,
): Promise<void> {
	const sealed = await seal(keyring, devices, text);
	socket.send(JSON.stringify({ ...sealed, device: fingerprint }));
}

/**
 * Blocks or unblocks a conversation.
 *
 * @param roomId The room.
 * @param blocked Whether it should be blocked.
 *
 * @example
 * await setBlocked(roomId, true);
 */
export async function setBlocked(roomId: string, blocked: boolean): Promise<void> {
	await call(`/${roomId}/block`, { method: blocked ? 'POST' : 'DELETE' });
}

/**
 * Reports a message, disclosing what it said.
 *
 * The plaintext comes from here because the server cannot produce it — and the signature it was
 * sent with is what lets a moderator check the disclosure rather than take it on trust.
 *
 * @param roomId The room.
 * @param messageId The message.
 * @param reason Why.
 * @param disclosedText What it said.
 *
 * @example
 * await report(roomId, message.id, 'threats', message.text ?? '');
 */
export async function report(
	roomId: string,
	messageId: string,
	reason: string,
	disclosedText: string,
): Promise<void> {
	await call(`/${roomId}/report`, {
		method: 'POST',
		body: JSON.stringify({ messageId, reason, disclosedText }),
	});
}
