import type { ServerWebSocket } from 'bun';
import { Hono, type MiddlewareHandler } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import type { WSContext } from 'hono/ws';
import * as v from 'valibot';
import {
	BlockedView,
	Created,
	DeviceKeyView,
	ErrorFrameView,
	IdParam,
	MessageFrameView,
	MessageView,
	presentDeviceKey,
	presentMessage,
	presentMessageFrame,
	presentRoomSummary,
	PublishedView,
	PublishKeyBody,
	ReportBody,
	RetentionBody,
	RetentionView,
	RoomSummaryView,
	SendMessageBody,
	type SendMessageFrame,
	StaleDevicesFrameView,
	StartRoomBody,
	TicketView,
	TranscriptQuery,
	UserParam,
} from '@akashic/contracts';
import { Unauthenticated } from '@akashic/lib/errors';
import { mapOk } from '@akashic/lib/result';
import { type AppEnv, callerOf } from '@/http/env.ts';
import { problemResponse } from '@/http/problem.ts';
import { reply, respond } from '@/http/reply.ts';
import { validate } from '@/http/validate.ts';
import type { ModuleRoutes } from '../module.ts';
import type { RoomRoutesDeps, Sent, SocketEnv, TicketClaim } from './room.types.ts';

const Keys = v.array(DeviceKeyView);
const Summaries = v.array(RoomSummaryView);
const Messages = v.array(MessageView);

const roomTopic = (roomId: string) => `room:${roomId}`;

export function createRoomRoutes(deps: RoomRoutesDeps): ModuleRoutes {
	const { rooms, messages, moderation } = deps.services;

	const privateRoutes = new Hono<AppEnv>()
		.put('/rooms/keys/me', validate('json', PublishKeyBody), async (c) =>
			reply(c, PublishedView, await rooms.publishKey(callerOf(c).id, c.req.valid('json'))),
		)
		.get('/rooms/keys/:userId', validate('param', UserParam), async (c) =>
			respond(
				c,
				mapOk(await rooms.keysOf(c.req.valid('param').userId), (keys) =>
					keys.map(presentDeviceKey),
				),
				Keys,
			),
		)
		.get('/rooms', async (c) =>
			reply(c, Summaries, (await rooms.inbox(callerOf(c).id)).map(presentRoomSummary)),
		)
		.post('/rooms', validate('json', StartRoomBody), async (c) =>
			respond(c, await rooms.start(callerOf(c).id, c.req.valid('json')), Created, 201),
		)
		.get(
			'/rooms/:id/messages',
			validate('param', IdParam),
			validate('query', TranscriptQuery),
			async (c) =>
				respond(
					c,
					mapOk(
						await messages.transcript(
							c.req.valid('param').id,
							callerOf(c).id,
							c.req.valid('query'),
						),
						(stored) => stored.map(presentMessage),
					),
					Messages,
				),
		)
		.post('/rooms/:id/ticket', validate('param', IdParam), async (c) =>
			respond(c, await rooms.ticket(c.req.valid('param').id, callerOf(c).id), TicketView),
		)
		.post('/rooms/:id/block', validate('param', IdParam), async (c) =>
			respond(c, await moderation.block(c.req.valid('param').id, callerOf(c).id), BlockedView),
		)
		.delete('/rooms/:id/block', validate('param', IdParam), async (c) =>
			respond(c, await moderation.unblock(c.req.valid('param').id, callerOf(c).id), BlockedView),
		)
		.put(
			'/rooms/:id/retention',
			validate('param', IdParam),
			validate('json', RetentionBody),
			async (c) =>
				respond(
					c,
					await moderation.setRetention(
						c.req.valid('param').id,
						callerOf(c).id,
						c.req.valid('json').days,
					),
					RetentionView,
				),
		)
		.post(
			'/rooms/:id/report',
			validate('param', IdParam),
			validate('json', ReportBody),
			async (c) =>
				respond(
					c,
					await moderation.report(c.req.valid('param').id, callerOf(c).id, c.req.valid('json')),
					Created,
					201,
				),
		);

	return { private: privateRoutes, root: createRoomSocket(deps) };
}

/**
 * `/ws/rooms/:id?ticket=…`: every participant's sockets receive every message in the room. The
 * ticket rides in the query string because a WebSocket upgrade can't carry the session cookie;
 * one that doesn't admit the caller to this room is refused before any upgrade.
 */
function createRoomSocket(deps: RoomRoutesDeps): Hono<AppEnv> {
	const { rooms, messages } = deps.services;
	const { relay } = deps;
	const log = deps.logger.child({ component: 'room-socket' });

	const admit: MiddlewareHandler<SocketEnv> = async (c, next) => {
		const ticket = new URL(c.req.url).searchParams.get('ticket') ?? '';
		const admitted = await rooms.admit(c.req.param('id') ?? '', ticket);
		if (!admitted) {
			return problemResponse(c, new Unauthenticated('That ticket does not admit you here.'));
		}
		c.set('admitted', admitted);
		await next();
	};

	const socket = new Hono<SocketEnv>().get(
		'/ws/rooms/:id',
		validate('param', IdParam),
		admit,
		upgradeWebSocket((c) => {
			const { roomId, userId }: TicketClaim = c.get('admitted');
			const topic = roomTopic(roomId);
			return {
				onOpen(_event, ws) {
					bunSocket(ws).subscribe(topic);
				},
				async onMessage(event, ws) {
					const read = readFrame(event.data);
					if ('problem' in read) {
						ws.send(errorFrame(read.problem));
						return;
					}
					try {
						const sent = await messages.send(roomId, userId, read.frame);
						if (!sent.ok) {
							ws.send(errorFrame(sent.error.message));
							return;
						}
						const answer = outcome(sent.value);
						if (answer.toRoom) {
							// `publish` skips the sender's own socket, so it gets its copy below.
							bunSocket(ws).publish(topic, answer.toRoom);
							relay.publish(topic, answer.toRoom);
						}
						ws.send(answer.toSender);
					} catch (cause) {
						log.error({ err: cause, roomId }, 'could not store a room message');
						ws.send(errorFrame('Could not send that. Try again.'));
					}
				},
			};
		}),
	);

	return new Hono<AppEnv>().route('/', socket);
}

/** Bun's own socket under Hono's, for its topic pub/sub. */
const bunSocket = (ws: WSContext) => ws.raw as ServerWebSocket<unknown>;

const errorFrame = (detail: string) =>
	JSON.stringify(v.parse(ErrorFrameView, { type: 'error', detail }));

type ReadFrame = { frame: SendMessageFrame } | { problem: string };

/** The frame a client sent, or what's wrong with it, in words fit to send back. */
function readFrame(raw: unknown): ReadFrame {
	let parsed: unknown = raw;
	try {
		if (typeof raw === 'string') parsed = JSON.parse(raw);
	} catch {
		return { problem: 'That was not JSON.' };
	}
	const checked = v.safeParse(SendMessageBody, parsed);
	if (checked.success) return { frame: checked.output };
	const [issue] = checked.issues;
	const path = (issue.path ?? []).map((item) => `/${String(item.key)}`).join('');
	return { problem: `${path || '(frame)'}: ${issue.message}` };
}

type Outcome = { toSender: string; toRoom?: string };

/** What a send's result means for the sender, and for everyone else in the room. */
function outcome(result: Sent): Outcome {
	if ('staleDevices' in result) {
		const frame = v.parse(StaleDevicesFrameView, {
			type: 'stale_devices',
			devices: result.staleDevices,
		});
		return { toSender: JSON.stringify(frame) };
	}
	const payload = JSON.stringify(v.parse(MessageFrameView, presentMessageFrame(result.sent)));
	return { toSender: payload, toRoom: payload };
}
