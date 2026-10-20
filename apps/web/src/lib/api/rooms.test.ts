import { describe, expect, mock, test } from 'bun:test';
import * as v from 'valibot';
import { MessageFrameView, MessageView } from '@akashic/contracts';

// bun test has no SvelteKit aliases, so the config module is stubbed before rooms.ts loads.
mock.module('$lib/config', () => ({ API_BASE: 'http://api.test' }));
const rooms = await import('./rooms');

const stored = {
	id: 'm1',
	senderId: 'u1',
	body: 'sealed',
	iv: 'iv',
	signature: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	wrappedKey: null,
	keyIv: null,
};

describe('a live frame the API sends', () => {
	const frame = {
		type: 'message',
		message: { ...stored, keys: [{ fingerprint: 'f'.repeat(8), wrappedKey: 'w', iv: 'iv' }] },
	};

	test('parses with the contract view', () => {
		expect(v.safeParse(rooms.LiveFrame, frame).success).toBe(true);
		expect(v.safeParse(MessageFrameView, frame).success).toBe(true);
	});

	test('without its envelopes it is not a live frame', () => {
		const bare = { type: 'message', message: stored };
		expect(v.safeParse(rooms.LiveFrame, bare).success).toBe(false);
	});
});

describe('a transcript row', () => {
	test('parses with the contract view', () => {
		expect(v.safeParse(rooms.StoredMessage, stored).success).toBe(true);
		expect(v.safeParse(MessageView, stored).success).toBe(true);
	});
});

describe('ServerFrame', () => {
	test('a message frame parses', () => {
		const frame = {
			type: 'message',
			message: { ...stored, keys: [{ fingerprint: 'f'.repeat(8), wrappedKey: 'w', iv: 'iv' }] },
		};
		expect(v.safeParse(rooms.ServerFrame, frame).success).toBe(true);
	});

	test('a stale_devices frame parses', () => {
		const frame = { type: 'stale_devices', devices: ['abcd1234'] };
		expect(v.safeParse(rooms.ServerFrame, frame).success).toBe(true);
	});

	test('an error frame parses', () => {
		expect(v.safeParse(rooms.ServerFrame, { type: 'error', detail: 'no' }).success).toBe(true);
	});

	test('an unknown type fails', () => {
		expect(v.safeParse(rooms.ServerFrame, { type: 'surprise' }).success).toBe(false);
	});
});
