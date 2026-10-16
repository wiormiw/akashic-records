import { afterAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createDb, roomMessages, rooms, type Tx } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { ErrorCode } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { expectErr, expectOk } from '@akashic/lib/testing';
import { agreeOn } from '@/modules/room/room.moderation.service.ts';
import { databaseUrl } from '../../support/fixtures.ts';
import { outgoing, world, type World } from './fixtures.ts';

describe('retention agreement', () => {
	const room = { days: null, agreedBy: null, low: 'ann', high: 'bob' };

	test('takes force once both participants agree on the same number', () => {
		const first = agreeOn(room, 30, 'ann');
		expect(first).toEqual({ agreedBy: ['ann'], inForce: false });
		expect(agreeOn({ ...room, days: 30, agreedBy: first.agreedBy }, 30, 'bob')).toEqual({
			agreedBy: ['ann', 'bob'],
			inForce: true,
		});
	});

	test('a different number starts the agreement over', () => {
		expect(agreeOn({ ...room, days: 30, agreedBy: ['ann'] }, 7, 'bob')).toEqual({
			agreedBy: ['bob'],
			inForce: false,
		});
	});
});

// Blocks, reports and retention on the real database, each test in a transaction that is rolled
// back.

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

describe.skipIf(!live)('blocking', () => {
	test('either person closes the room; unblocking lifts only their own block', () =>
		inWorld(async (w) => {
			const { roomId, alice, bob } = await w.room();
			expect(expectOk(await w.moderation.block(roomId, alice))).toEqual({ blocked: true });
			// Twice is still one block.
			expectOk(await w.moderation.block(roomId, alice));
			expectOk(await w.moderation.block(roomId, bob));
			expect((await w.blockRows(roomId)).map((row) => row.blockerId).sort()).toEqual(
				[alice, bob].sort(),
			);

			expect(expectOk(await w.moderation.unblock(roomId, alice))).toEqual({ blocked: false });
			expect((await w.blockRows(roomId)).map((row) => row.blockerId)).toEqual([bob]);
		}));

	test("someone outside the room can't block or unblock it", () =>
		inWorld(async (w) => {
			const { roomId } = await w.room();
			const stranger = await w.person('Stranger');
			expectErr(await w.moderation.block(roomId, stranger), ErrorCode.event.notFound);
			expectErr(await w.moderation.unblock(roomId, stranger), ErrorCode.event.notFound);
			expect(await w.blockRows(roomId)).toEqual([]);
		}));
});

describe.skipIf(!live)('reporting a message', () => {
	test("the other person's message is reported, with what it said", () =>
		inWorld(async (w) => {
			const { roomId, alice, bob } = await w.room();
			await w.devices([alice, 'alice-phone'], [bob, 'bob-laptop']);
			const sent = expectOk(
				await w.messages.send(roomId, bob, outgoing('rude', 'alice-phone', 'bob-laptop')),
			);
			if (!('sent' in sent)) throw new Error('expected a stored message');

			const { id } = expectOk(
				await w.moderation.report(roomId, alice, {
					messageId: sent.sent.id,
					reason: 'threats',
					disclosedText: 'the plaintext',
				}),
			);
			expect(await w.reportRows(roomId)).toEqual([
				expect.objectContaining({
					id,
					messageId: sent.sent.id,
					reporterId: alice,
					accusedId: bob,
					reason: 'threats',
					disclosedText: 'the plaintext',
				}),
			]);
		}));

	test("one's own message, a message from another room and an outsider are refused", () =>
		inWorld(async (w) => {
			const { roomId, alice, bob } = await w.room();
			const other = await w.room();
			await w.devices([alice, 'alice-phone'], [bob, 'bob-laptop']);
			await w.devices([other.alice, 'o-alice-phone'], [other.bob, 'o-bob-laptop']);
			const mine = expectOk(
				await w.messages.send(roomId, alice, outgoing('mine', 'alice-phone', 'bob-laptop')),
			);
			const elsewhere = expectOk(
				await w.messages.send(
					other.roomId,
					other.bob,
					outgoing('elsewhere', 'o-alice-phone', 'o-bob-laptop'),
				),
			);
			if (!('sent' in mine) || !('sent' in elsewhere)) throw new Error('expected messages');
			const stranger = await w.person('Stranger');
			const report = (messageId: string) => ({ messageId, reason: 'spam' });

			expectErr(
				await w.moderation.report(roomId, alice, report(mine.sent.id)),
				ErrorCode.common.validation,
			);
			expectErr(
				await w.moderation.report(roomId, alice, report(elsewhere.sent.id)),
				ErrorCode.event.notFound,
			);
			expectErr(
				await w.moderation.report(roomId, stranger, report(mine.sent.id)),
				ErrorCode.event.notFound,
			);
			expect(await w.reportRows(roomId)).toEqual([]);
		}));
});

describe.skipIf(!live)('retention', () => {
	test('takes force only once both people agree on the same number', () =>
		inWorld(async (w) => {
			const { roomId, alice, bob } = await w.room();
			const retain = async (userId: string, days: number | null) =>
				expectOk(await w.moderation.setRetention(roomId, userId, days));

			expect(await retain(alice, 30)).toEqual({ days: 30, inForce: false });
			// A different number starts the agreement over.
			expect(await retain(bob, 7)).toEqual({ days: 7, inForce: false });
			expect(await retain(alice, 7)).toEqual({ days: 7, inForce: true });
			expect(await w.roomRow(roomId)).toMatchObject({
				retentionDays: 7,
				retentionAgreedBy: expect.arrayContaining([alice, bob]),
			});
			// Keeping everything is a proposal like any other.
			expect(await retain(bob, null)).toEqual({ days: null, inForce: false });
		}));

	test("someone outside the room can't set it", () =>
		inWorld(async (w) => {
			const { roomId } = await w.room();
			const stranger = await w.person('Stranger');
			expectErr(await w.moderation.setRetention(roomId, stranger, 7), ErrorCode.event.notFound);
			expect((await w.roomRow(roomId)).retentionDays).toBeNull();
		}));

	test('the sweep deletes messages past an agreed retention, and only those', () =>
		inWorld(async (w, tx) => {
			const agreed = await w.room();
			const proposed = await w.room();
			for (const r of [agreed, proposed]) {
				await w.devices([r.alice, `${r.roomId}-a`], [r.bob, `${r.roomId}-b`]);
			}
			expectOk(await w.moderation.setRetention(agreed.roomId, agreed.alice, 7));
			expectOk(await w.moderation.setRetention(agreed.roomId, agreed.bob, 7));
			// Only one person asked: nothing is deleted there.
			expectOk(await w.moderation.setRetention(proposed.roomId, proposed.alice, 7));

			const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
			const write = (roomId: string, senderId: string, body: string, createdAt?: Date) =>
				tx
					.insert(roomMessages)
					.values({ roomId, senderId, body, iv: 'iv-12345678', createdAt })
					.returning({ id: roomMessages.id });
			await write(agreed.roomId, agreed.alice, 'old', old);
			const [recent] = await write(agreed.roomId, agreed.bob, 'recent');
			const [kept] = await write(proposed.roomId, proposed.alice, 'old but kept', old);

			expect(await w.moderation.sweepExpired()).toBeGreaterThanOrEqual(1);
			expect((await w.messageRows(agreed.roomId)).map((m) => m.id)).toEqual([recent!.id]);
			expect((await w.messageRows(proposed.roomId)).map((m) => m.id)).toEqual([kept!.id]);
			// The rooms themselves stay.
			expect(await tx.select().from(rooms).where(eq(rooms.id, agreed.roomId))).toHaveLength(1);
		}));
});
