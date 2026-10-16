import { afterAll, describe, expect, test } from 'bun:test';
import { createDb, roomBlocks, roomMessages, type Tx } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { ErrorCode } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { expectErr, expectOk } from '@akashic/lib/testing';
import { policy } from '@/config.ts';
import { databaseUrl } from '../../support/fixtures.ts';
import { outgoing, world, type World } from './fixtures.ts';

// Sending to a room and reading its transcript on the real database, each test in a transaction
// that is rolled back. (Ported from room-send.test.ts, which used a fake repository.)

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const inWorld = (run: (w: World, tx: Tx) => Promise<void>) =>
	withRollback(database.db, (tx) => run(world(tx), tx));

/** A room between alice and bob, each with one device. */
async function conversation(w: World) {
	const room = await w.room();
	await w.devices([room.alice, 'alice-phone'], [room.bob, 'bob-laptop']);
	return room;
}

describe.skipIf(!live)('sending to a room', () => {
	test("a message encrypted for every device is stored, with its keys and the room's recency", () =>
		inWorld(async (w) => {
			const { roomId, alice } = await conversation(w);
			const message = outgoing('ciphertext', 'alice-phone', 'bob-laptop');

			const sent = expectOk(await w.messages.send(roomId, alice, message));
			expect(sent).toMatchObject({
				sent: { senderId: alice, body: 'ciphertext', iv: message.iv, keys: message.keys },
			});
			if (!('sent' in sent)) throw new Error('expected a stored message');

			const [row] = await w.messageRows(roomId);
			expect(row).toMatchObject({ id: sent.sent.id, senderId: alice, body: 'ciphertext' });
			expect((await w.keyRows(sent.sent.id)).map((key) => key.fingerprint).sort()).toEqual([
				'alice-phone',
				'bob-laptop',
			]);
			expect((await w.roomRow(roomId)).lastMessageAt).toEqual(row!.createdAt);
		}));

	test('a device the sender missed sends back the current list, storing nothing', () =>
		inWorld(async (w) => {
			const { roomId, alice } = await conversation(w);
			const answer = expectOk(await w.messages.send(roomId, alice, outgoing('hi', 'alice-phone')));
			expect(answer).toEqual({
				staleDevices: expect.arrayContaining(['alice-phone', 'bob-laptop']),
			});
			expect(await w.messageRows(roomId)).toEqual([]);
		}));

	test('an outsider, a closed room and a flood are refused, storing nothing', () =>
		inWorld(async (w, tx) => {
			const all = outgoing('ciphertext', 'alice-phone', 'bob-laptop');

			const outsider = await conversation(w);
			const mallory = await w.person('Mallory');
			expectErr(await w.messages.send(outsider.roomId, mallory, all), ErrorCode.event.notFound);
			expect(await w.messageRows(outsider.roomId)).toEqual([]);

			const closed = await conversation(w);
			await tx.insert(roomBlocks).values({ roomId: closed.roomId, blockerId: closed.bob });
			expectErr(await w.messages.send(closed.roomId, closed.alice, all), ErrorCode.realm.forbidden);
			expect(await w.messageRows(closed.roomId)).toEqual([]);

			const flood = await conversation(w);
			await tx.insert(roomMessages).values(
				Array.from({ length: policy.rooms.messagesPerMinute }, () => ({
					roomId: flood.roomId,
					senderId: flood.alice,
					body: 'earlier',
					iv: 'iv-12345678',
				})),
			);
			expectErr(
				await w.messages.send(flood.roomId, flood.alice, all),
				ErrorCode.common.rateLimited,
			);
			// The other person isn't the one flooding.
			expectOk(await w.messages.send(flood.roomId, flood.bob, all));
		}));
});

describe.skipIf(!live)('reading a transcript', () => {
	test('each message comes back with the key wrapped for the asking device, in order', () =>
		inWorld(async (w) => {
			const { roomId, alice, bob } = await conversation(w);
			const first = expectOk(
				await w.messages.send(roomId, alice, outgoing('one', 'alice-phone', 'bob-laptop')),
			);
			const second = expectOk(
				await w.messages.send(roomId, bob, outgoing('two', 'alice-phone', 'bob-laptop')),
			);
			if (!('sent' in first) || !('sent' in second)) throw new Error('expected stored messages');

			const forBob = expectOk(
				await w.messages.transcript(roomId, bob, { limit: 100, device: 'bob-laptop' }),
			);
			expect(forBob.map((m) => m.body)).toEqual(['one', 'two']);
			expect(forBob[0]).toMatchObject({
				senderId: alice,
				signature: null,
				wrappedKey: 'wrapped-for-bob-laptop',
				keyIv: 'iv-12345678',
			});

			// No device, or one the message wasn't addressed to: no key.
			const unaddressed = expectOk(await w.messages.transcript(roomId, bob, { limit: 100 }));
			expect(unaddressed.map((m) => m.wrappedKey)).toEqual([null, null]);

			// A page after the first message, and a page of one.
			const after = expectOk(
				await w.messages.transcript(roomId, alice, { limit: 100, after: first.sent.id }),
			);
			expect(after.map((m) => m.id)).toEqual([second.sent.id]);
			const one = expectOk(await w.messages.transcript(roomId, alice, { limit: 1 }));
			expect(one.map((m) => m.id)).toEqual([first.sent.id]);
		}));

	test('someone outside the room reads nothing', () =>
		inWorld(async (w) => {
			const { roomId } = await conversation(w);
			const stranger = await w.person('Stranger');
			expectErr(
				await w.messages.transcript(roomId, stranger, { limit: 10 }),
				ErrorCode.event.notFound,
			);
		}));
});
