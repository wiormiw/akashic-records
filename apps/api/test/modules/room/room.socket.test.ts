import { afterAll, describe, expect, test } from 'bun:test';
import { websocket } from 'hono/bun';
import * as v from 'valibot';
import type { Authorizer } from '@akashic/authz';
import { createDb, type Db } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { ErrorCode, RealmForbidden } from '@akashic/lib/errors';
import { createLifecycle } from '@akashic/lib/lifecycle';
import { silentLogger } from '@akashic/lib/log';
import { err, ok } from '@akashic/lib/result';
import { expectOk } from '@akashic/lib/testing';
import { createApp } from '@/app.ts';
import type { Auth } from '@/auth/auth.ts';
import { sessions } from '@/http/session.ts';
import { createMemoryCounters } from '@/integrations/counters.ts';
import { createRateLimiter } from '@/integrations/rate-limit.ts';
import type { Relay } from '@/integrations/relay.ts';
import { createRoomRoutes } from '@/modules/room/room.routes.ts';
import { createTickets } from '@/modules/room/room.service.ts';
import type { RoomServices } from '@/modules/room/room.types.ts';
import { clock, databaseUrl } from '../../support/fixtures.ts';
import { outgoing, TICKET_SECRET, Web, world } from './fixtures.ts';

// The room socket over real WebSockets, served as main.ts serves the app: the whole app, through
// Bun.serve with Hono's `websocket` handler.

type Frame = Record<string, unknown>;

/**
 * The room's routes inside the whole app (request context, security headers, CORS, the problem
 * handler) on a real server; `relayed` collects what it sends other instances. Nobody is signed
 * in: the socket needs no session, only its ticket.
 */
function serve(services: RoomServices) {
	const relayed: string[] = [];
	const relay: Relay = {
		publish: (_topic, payload) => void relayed.push(payload),
		start: async () => {},
	};
	const lifecycle = createLifecycle(silentLogger());
	lifecycle.markReady();
	const auth = { api: { getSession: async () => null } } as unknown as Auth;
	const rule = { limit: 1000, windowSeconds: 60 };
	const app = createApp({
		logger: silentLogger(),
		lifecycle,
		auth,
		sessions: sessions({
			auth,
			db: {} as Db,
			authorizer: { check: async () => false } as unknown as Authorizer,
		}),
		mailer: {
			send: async () => {},
			health: () => ({ configured: false, healthy: false, lastFailure: null, failedAt: null }),
		},
		limiter: createRateLimiter({ counters: createMemoryCounters() }),
		limits: {
			api: { ...rule, bucket: 'api' },
			auth: { ...rule, bucket: 'auth-read' },
			credentials: { ...rule, bucket: 'auth' },
		},
		allowedOrigins: ['http://localhost:5173'],
		maxBodyBytes: 1024 * 1024,
		budgetMs: 5000,
		trustProxy: false,
		checks: { required: {}, optional: {} },
		modules: [createRoomRoutes({ services, relay, logger: silentLogger() })],
	});
	const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
	return {
		relayed,
		url: (roomId: string, ticket: string) =>
			`localhost:${server.port}/ws/rooms/${roomId}?ticket=${encodeURIComponent(ticket)}`,
		stop: () => server.stop(true),
	};
}

/** Opens a socket and collects what it receives. Resolves once open, rejects if refused. */
function connect(
	url: string,
): Promise<{ ws: WebSocket; next: () => Promise<Frame>; inbox: Frame[] }> {
	const ws = new WebSocket(`ws://${url}`);
	const inbox: Frame[] = [];
	const waiting: ((frame: Frame) => void)[] = [];
	ws.onmessage = (event) => {
		const frame = JSON.parse(String(event.data)) as Frame;
		const waiter = waiting.shift();
		if (waiter) waiter(frame);
		else inbox.push(frame);
	};
	const next = () =>
		new Promise<Frame>((resolve) => {
			const queued = inbox.shift();
			if (queued) resolve(queued);
			else waiting.push(resolve);
		});
	return new Promise((resolve, reject) => {
		ws.onopen = () => resolve({ ws, next, inbox });
		ws.onerror = () => reject(new Error('refused'));
	});
}

/**
 * A ticket refused as the socket refuses one: the upgrade request answers 401 with a problem, and
 * a real WebSocket never opens.
 */
async function expectRefused(url: string) {
	const response = await fetch(`http://${url}`, {
		headers: {
			connection: 'Upgrade',
			upgrade: 'websocket',
			'sec-websocket-version': '13',
			'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
		},
	});
	expect(response.status).toBe(401);
	expect(((await response.json()) as { code: string }).code).toBe(ErrorCode.auth.unauthenticated);
	await expect(connect(url)).rejects.toThrow('refused');
}

// What the web app parses a live frame with (the same schema as its transcript, plus `keys`).
const LiveFrame = v.object({ type: v.literal('message'), message: Web.StoredMessage });

// ---- The handler's branches, with a scripted service -----------------------------------------

const ROOM = '01a0d6ac-0000-7000-8000-000000000001';
const OTHER_ROOM = '01a0d6ac-0000-7000-8000-000000000002';

// The message body picks the outcome, so each test drives one branch of the handler.
const scripted = {
	rooms: {
		admit: async (roomId: string, ticket: string) =>
			(roomId === ROOM || roomId === OTHER_ROOM) && ticket.startsWith('ok-') ? { roomId, userId: ticket.slice(3) } : null,
	},
	messages: {
		send: async (_roomId: string, senderId: string, message: { body: string }) => {
			if (message.body === 'refuse') return err(new RealmForbidden('The room is closed.'));
			if (message.body === 'stale') return ok({ staleDevices: ['device-b'] });
			if (message.body === 'explode') throw new Error('database down');
			return ok({
				sent: {
					...message,
					id: 'm1',
					senderId,
					createdAt: Temporal.Instant.from('2026-06-01T00:00:00Z'),
				},
			});
		},
	},
} as unknown as RoomServices;

const frame = (body: string) =>
	JSON.stringify({
		body,
		iv: 'iv-12345678',
		device: 'device-a',
		keys: [{ fingerprint: 'device-b', wrappedKey: 'k'.repeat(16), iv: 'iv-12345678' }],
	});

describe('room socket', () => {
	const server = serve(scripted);
	afterAll(() => server.stop());

	test("no ticket, or one that doesn't admit, is refused; a bad room id is a 400", async () => {
		await expectRefused(server.url(ROOM, 'bad'));
		await expectRefused(server.url(ROOM, ''));
		const badId = await fetch(`http://${server.url('not-a-uuid', 'ok-alice')}`);
		expect(badId.status).toBe(400);
	});

	test('tells the sender what was wrong with a frame', async () => {
		const { ws, next } = await connect(server.url(ROOM, 'ok-alice'));
		ws.send('not json');
		expect(await next()).toEqual({ type: 'error', detail: 'That was not JSON.' });
		ws.send(JSON.stringify({ body: 'hi' }));
		expect(String((await next()).detail)).toMatch(/^\/\w+: /);
		ws.send(JSON.stringify(42));
		expect(String((await next()).detail)).toMatch(/^\(frame\): /);
		ws.close();
	});

	test('a refusal and a stale-device answer go to the sender only', async () => {
		const { ws, next } = await connect(server.url(ROOM, 'ok-alice'));
		ws.send(frame('refuse'));
		expect(await next()).toEqual({ type: 'error', detail: 'The room is closed.' });
		ws.send(frame('stale'));
		expect(await next()).toEqual({ type: 'stale_devices', devices: ['device-b'] });
		ws.close();
	});

	test("a stored message reaches both sides and the other replicas, without anyone's key", async () => {
		const alice = await connect(server.url(ROOM, 'ok-alice'));
		const bob = await connect(server.url(ROOM, 'ok-bob'));
		const before = server.relayed.length;

		alice.ws.send(frame('hello'));
		const [mine, theirs] = await Promise.all([alice.next(), bob.next()]);
		expect(mine).toEqual(theirs);
		v.parse(LiveFrame, mine);
		expect(mine).toMatchObject({
			type: 'message',
			message: {
				id: 'm1',
				senderId: 'alice',
				body: 'hello',
				signature: null,
				wrappedKey: null,
				keyIv: null,
				createdAt: '2026-06-01T00:00:00Z',
				// Every device's envelope rides along: one frame goes to both people.
				keys: [{ fingerprint: 'device-b', wrappedKey: 'k'.repeat(16), iv: 'iv-12345678' }],
			},
		});
		expect(server.relayed.slice(before).map((payload) => JSON.parse(payload))).toEqual([mine]);
		alice.ws.close();
		bob.ws.close();
	});

	test("a message in one room doesn't reach a socket in another", async () => {
		const alice = await connect(server.url(ROOM, 'ok-alice'));
		const bob = await connect(server.url(ROOM, 'ok-bob'));
		const elsewhere = await connect(server.url(OTHER_ROOM, 'ok-carol'));

		alice.ws.send(frame('hello'));
		// The control: the other person in the same room does get it.
		v.parse(LiveFrame, await bob.next());
		await alice.next();
		await Bun.sleep(100);
		expect(elsewhere.inbox).toEqual([]);
		alice.ws.close();
		bob.ws.close();
		elsewhere.ws.close();
	});

	test('a storage failure is reported to the sender, not dropped', async () => {
		const { ws, next } = await connect(server.url(ROOM, 'ok-alice'));
		ws.send(frame('explode'));
		expect(await next()).toEqual({ type: 'error', detail: 'Could not send that. Try again.' });
		ws.close();
	});
});

// ---- Admission with real tickets, on the real database ---------------------------------------

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)('room socket admission', () => {
	// The server's queries run on the test's transaction, so everything is rolled back after.
	test("an expired ticket, another room's ticket and a forged one are refused with no upgrade", () =>
		withRollback(database.db, async (tx) => {
			const w = world(tx);
			const { roomId, alice } = await w.room();
			const other = await w.room();
			// Alice is in the other room too, so its ticket is genuine, just not for this room.
			await w.join(other.id, alice);
			const { id: theirs } = expectOk(
				await w.rooms.start(alice, {
					realmSlug: other.slug,
					subjectKind: 1,
					subjectId: other.subjectId,
					withUserId: other.bob,
				}),
			);
			const server = serve(w);
			try {
				const tickets = createTickets({ secret: TICKET_SECRET, ttl: { seconds: 60 } });
				const expired = tickets.issue(roomId, alice, clock.now().subtract({ minutes: 2 }));
				const { ticket: forOther } = expectOk(await w.rooms.ticket(theirs, alice));
				const signature = forOther.split(':').at(-1)!;
				const forged = `${roomId}:${alice}:${clock.now().add({ minutes: 1 }).epochMilliseconds}:${signature}`;
				const foreignSecret = createTickets({
					secret: 'not-our-secret-'.repeat(3),
					ttl: { seconds: 60 },
				}).issue(roomId, alice, clock.now());

				await expectRefused(server.url(roomId, expired));
				await expectRefused(server.url(roomId, forOther));
				await expectRefused(server.url(roomId, forged));
				await expectRefused(server.url(roomId, foreignSecret));

				// The control: a genuine ticket for this room opens, and the other room's opens there.
				const { ticket } = expectOk(await w.rooms.ticket(roomId, alice));
				(await connect(server.url(roomId, ticket))).ws.close();
				(await connect(server.url(theirs, forOther))).ws.close();
			} finally {
				await server.stop();
			}
		}));

	test('a message sent over the socket is stored and reaches the other person', () =>
		withRollback(database.db, async (tx) => {
			const w = world(tx);
			const { roomId, alice, bob } = await w.room();
			await w.devices([alice, 'alice-phone'], [bob, 'bob-laptop']);
			const server = serve(w);
			try {
				const ticketOf = async (userId: string) =>
					expectOk(await w.rooms.ticket(roomId, userId)).ticket;
				const a = await connect(server.url(roomId, await ticketOf(alice)));
				const b = await connect(server.url(roomId, await ticketOf(bob)));

				a.ws.send(JSON.stringify({ ...outgoing('sealed', 'alice-phone'), device: 'alice-phone' }));
				expect(await a.next()).toEqual({
					type: 'stale_devices',
					devices: expect.arrayContaining(['alice-phone', 'bob-laptop']),
				});

				a.ws.send(
					JSON.stringify({
						...outgoing('sealed', 'alice-phone', 'bob-laptop'),
						device: 'alice-phone',
					}),
				);
				const [mine, theirs] = await Promise.all([a.next(), b.next()]);
				expect(theirs).toEqual(mine);
				v.parse(LiveFrame, mine);
				const [stored] = await w.messageRows(roomId);
				expect(mine).toMatchObject({
					type: 'message',
					message: { id: stored!.id, senderId: alice, body: 'sealed' },
				});
				expect(server.relayed.map((payload) => JSON.parse(payload))).toEqual([mine]);
				a.ws.close();
				b.ws.close();
			} finally {
				await server.stop();
			}
		}));
});
