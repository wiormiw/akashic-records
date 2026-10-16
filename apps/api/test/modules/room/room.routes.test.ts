import { afterAll, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createDb } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { RoomSubject } from '@akashic/lib/enums';
import { silentLogger } from '@akashic/lib/log';
import { databaseUrl } from '../../support/fixtures.ts';
import { roomApp } from './app.ts';
import { deviceKey, outgoing, Web, world, type World } from './fixtures.ts';

// Every room HTTP route through app.request, on the real database in a rolled-back transaction:
// the happy path parses with the web app's schema, and each group has its refusals.

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const scenario = (run: (s: ReturnType<typeof roomApp> & { w: World }) => Promise<void>) =>
	withRollback(database.db, (tx) => run({ ...roomApp(tx), w: world(tx) }));

describe.skipIf(!live)('device keys', () => {
	test('a device is published, and read back as the web app reads it', () =>
		scenario(async ({ call, w }) => {
			const ann = await w.person('Ann');
			expect(
				await call('PUT', '/api/v1/rooms/keys/me', { as: ann, body: deviceKey('ann-1234') }),
			).toEqual({ status: 200, body: { published: true } });

			const keys = await call('GET', `/api/v1/rooms/keys/${ann}`, { as: ann });
			expect(keys.status).toBe(200);
			expect(v.parse(v.array(Web.PublicKeys), keys.body)).toEqual([
				{ userId: ann, ...deviceKey('ann-1234') },
			]);
		}));

	test("signed out 401, a short key 400, nobody's keys 404, a bad id 400", () =>
		scenario(async ({ call, w }) => {
			const ann = await w.person('Ann');
			expect(
				(await call('PUT', '/api/v1/rooms/keys/me', { body: deviceKey('ann-1234') })).status,
			).toBe(401);
			const short = await call('PUT', '/api/v1/rooms/keys/me', {
				as: ann,
				body: { ...deviceKey('ann-1234'), publicKey: 'short' },
			});
			expect(short).toMatchObject({
				status: 400,
				body: { code: 'common.request.validation_failed' },
			});

			const none = await call('GET', `/api/v1/rooms/keys/${ann}`, { as: ann });
			expect(none).toMatchObject({ status: 404, body: { code: 'realm.not_member' } });
			expect((await call('GET', '/api/v1/rooms/keys/not-a-uuid', { as: ann })).status).toBe(400);
		}));
});

describe.skipIf(!live)('opening and listing rooms', () => {
	test('a room opens about a posting and shows in both inboxes', () =>
		scenario(async ({ call, w }) => {
			const { id, slug, people } = await w.realm(2);
			const [ann, bob] = people as [string, string];
			const listing = await w.listing(id, bob);

			const opened = await call('POST', '/api/v1/rooms', {
				as: ann,
				body: {
					realmSlug: slug,
					subjectKind: RoomSubject.listing,
					subjectId: listing,
					withUserId: bob,
				},
			});
			expect(opened.status).toBe(201);
			const { id: roomId } = v.parse(Web.Opened, opened.body);

			const inbox = await call('GET', '/api/v1/rooms', { as: bob });
			expect(inbox.status).toBe(200);
			expect(v.parse(v.array(Web.RoomSummary), inbox.body)).toEqual([
				expect.objectContaining({ id: roomId, realmId: id, otherId: ann, subjectId: listing }),
			]);
		}));

	test("signed out 401, a bad body 400, a stranger 403, another realm's posting 404", () =>
		scenario(async ({ call, w }) => {
			const { id, slug, people } = await w.realm(2);
			const [ann, bob] = people as [string, string];
			const listing = await w.listing(id, bob);
			const stranger = await w.person('Stranger');
			const elsewhere = await w.realm(1);
			const foreign = await w.listing(elsewhere.id, elsewhere.people[0]!);
			const body = (subjectId: string, withUserId: string) => ({
				realmSlug: slug,
				subjectKind: RoomSubject.listing,
				subjectId,
				withUserId,
			});

			expect((await call('POST', '/api/v1/rooms', { body: body(listing, bob) })).status).toBe(401);
			expect((await call('GET', '/api/v1/rooms')).status).toBe(401);
			const badKind = await call('POST', '/api/v1/rooms', {
				as: ann,
				body: { ...body(listing, bob), subjectKind: 9 },
			});
			expect(badKind.status).toBe(400);
			expect(
				(
					await call('POST', '/api/v1/rooms', {
						as: ann,
						body: { ...body(listing, bob), realmSlug: 'a b' },
					})
				).status,
			).toBe(400);
			expect(
				await call('POST', '/api/v1/rooms', { as: ann, body: body(listing, stranger) }),
			).toMatchObject({ status: 403, body: { code: 'realm.not_member' } });
			expect(
				await call('POST', '/api/v1/rooms', { as: ann, body: body(foreign, bob) }),
			).toMatchObject({ status: 404, body: { code: 'event.not_found' } });
			expect((await call('GET', '/api/v1/rooms', { as: ann })).body).toEqual([]);
		}));
});

describe.skipIf(!live)("a room's messages and ticket", () => {
	test('the transcript and a ticket parse as the web app reads them', () =>
		scenario(async ({ call, w }) => {
			const { roomId, alice, bob } = await w.room();
			await w.devices([alice, 'alice-phone'], [bob, 'bob-laptop']);
			await w.messages.send(roomId, alice, outgoing('sealed', 'alice-phone', 'bob-laptop'));

			const transcript = await call(
				'GET',
				`/api/v1/rooms/${roomId}/messages?device=bob-laptop&limit=10`,
				{ as: bob },
			);
			expect(transcript.status).toBe(200);
			expect(v.parse(v.array(Web.StoredMessage), transcript.body)).toEqual([
				expect.objectContaining({
					senderId: alice,
					body: 'sealed',
					wrappedKey: 'wrapped-for-bob-laptop',
				}),
			]);

			const ticket = await call('POST', `/api/v1/rooms/${roomId}/ticket`, { as: alice });
			expect(ticket.status).toBe(200);
			expect(v.parse(Web.Ticket, ticket.body)).toMatchObject({ expiresInSeconds: 60 });
		}));

	test('someone outside the room 404, a bad limit or id 400, signed out 401', () =>
		scenario(async ({ call, w }) => {
			const { roomId } = await w.room();
			const stranger = await w.person('Stranger');
			expect(await call('GET', `/api/v1/rooms/${roomId}/messages`, { as: stranger })).toMatchObject(
				{ status: 404, body: { code: 'event.not_found' } },
			);
			expect(await call('POST', `/api/v1/rooms/${roomId}/ticket`, { as: stranger })).toMatchObject({
				status: 404,
				body: { code: 'event.not_found' },
			});
			expect(
				(await call('GET', `/api/v1/rooms/${roomId}/messages?limit=0`, { as: stranger })).status,
			).toBe(400);
			expect(
				(await call('GET', `/api/v1/rooms/${roomId}/messages?limit=201`, { as: stranger })).status,
			).toBe(400);
			expect((await call('POST', '/api/v1/rooms/not-a-uuid/ticket', { as: stranger })).status).toBe(
				400,
			);
			expect((await call('POST', `/api/v1/rooms/${roomId}/ticket`)).status).toBe(401);
		}));
});

describe.skipIf(!live)('blocking, retention and reports', () => {
	test('a participant blocks and unblocks, agrees retention, and reports a message', () =>
		scenario(async ({ call, w }) => {
			const { roomId, alice, bob } = await w.room();
			await w.devices([alice, 'alice-phone'], [bob, 'bob-laptop']);
			const sent = await w.messages.send(
				roomId,
				bob,
				outgoing('rude', 'alice-phone', 'bob-laptop'),
			);
			if (!sent.ok || !('sent' in sent.value)) throw new Error('expected a stored message');

			expect(await call('POST', `/api/v1/rooms/${roomId}/block`, { as: alice })).toEqual({
				status: 200,
				body: { blocked: true },
			});
			expect(await call('DELETE', `/api/v1/rooms/${roomId}/block`, { as: alice })).toEqual({
				status: 200,
				body: { blocked: false },
			});

			const retain = (as: string, days: number | null) =>
				call('PUT', `/api/v1/rooms/${roomId}/retention`, { as, body: { days } });
			expect(await retain(alice, 30)).toEqual({ status: 200, body: { days: 30, inForce: false } });
			expect(await retain(bob, 30)).toEqual({ status: 200, body: { days: 30, inForce: true } });

			const report = await call('POST', `/api/v1/rooms/${roomId}/report`, {
				as: alice,
				body: { messageId: sent.value.sent.id, reason: 'threats', disclosedText: 'plaintext' },
			});
			expect(report.status).toBe(201);
			expect(v.parse(Web.Opened, report.body).id).toBe((await w.reportRows(roomId))[0]!.id);
		}));

	test("someone outside the room 404; bad days, a short reason, one's own message 400", () =>
		scenario(async ({ call, w }) => {
			const { roomId, alice, bob } = await w.room();
			await w.devices([alice, 'alice-phone'], [bob, 'bob-laptop']);
			const sent = await w.messages.send(
				roomId,
				alice,
				outgoing('mine', 'alice-phone', 'bob-laptop'),
			);
			if (!sent.ok || !('sent' in sent.value)) throw new Error('expected a stored message');
			const stranger = await w.person('Stranger');
			const messageId = sent.value.sent.id;

			expect(await call('POST', `/api/v1/rooms/${roomId}/block`, { as: stranger })).toMatchObject({
				status: 404,
				body: { code: 'event.not_found' },
			});
			expect(await call('DELETE', `/api/v1/rooms/${roomId}/block`, { as: stranger })).toMatchObject(
				{ status: 404, body: { code: 'event.not_found' } },
			);
			expect(
				await call('PUT', `/api/v1/rooms/${roomId}/retention`, { as: stranger, body: { days: 7 } }),
			).toMatchObject({ status: 404, body: { code: 'event.not_found' } });
			for (const days of [0, 3651, 1.5, '7']) {
				expect(
					(await call('PUT', `/api/v1/rooms/${roomId}/retention`, { as: alice, body: { days } }))
						.status,
				).toBe(400);
			}
			expect(
				(
					await call('POST', `/api/v1/rooms/${roomId}/report`, {
						as: bob,
						body: { messageId, reason: 'no' },
					})
				).status,
			).toBe(400);
			expect(
				await call('POST', `/api/v1/rooms/${roomId}/report`, {
					as: alice,
					body: { messageId, reason: 'spam' },
				}),
			).toMatchObject({ status: 400, body: { code: 'common.request.validation_failed' } });
			expect(
				await call('POST', `/api/v1/rooms/${roomId}/report`, {
					as: stranger,
					body: { messageId, reason: 'spam' },
				}),
			).toMatchObject({ status: 404, body: { code: 'event.not_found' } });
			expect(await w.reportRows(roomId)).toEqual([]);
		}));
});
