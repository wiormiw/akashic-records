import { describe, expect, test } from 'bun:test';
import { chooseAdapter, cspOrigins } from './build-config.ts';

describe('chooseAdapter', () => {
	test('a local build uses node', () => {
		expect(chooseAdapter({})).toBe('node');
	});

	test('a Vercel build uses vercel', () => {
		expect(chooseAdapter({ VERCEL: '1' })).toBe('vercel');
	});

	test('ADAPTER wins over VERCEL', () => {
		expect(chooseAdapter({ VERCEL: '1', ADAPTER: 'node' })).toBe('node');
	});

	test('an unknown ADAPTER fails the build', () => {
		expect(() => chooseAdapter({ ADAPTER: 'bogus' })).toThrow('ADAPTER must be node or vercel');
	});
});

describe('cspOrigins', () => {
	test('an https API gets a wss socket origin', () => {
		expect(cspOrigins({ PUBLIC_API_BASE: 'https://api.example.com' })).toEqual({
			connect: ['self', 'wss://api.example.com'],
			img: ['self', 'data:'],
		});
	});

	test('an http API gets a ws socket origin', () => {
		expect(cspOrigins({ PUBLIC_API_BASE: 'http://localhost:3000' }).connect).toEqual([
			'self',
			'ws://localhost:3000',
		]);
	});

	test('the media origin is reduced to its origin', () => {
		expect(cspOrigins({ PUBLIC_MEDIA_ORIGIN: 'https://media.example.com/bucket/' }).img).toEqual([
			'self',
			'data:',
			'https://media.example.com',
		]);
	});

	test('no API base leaves connect same-origin only', () => {
		expect(cspOrigins({}).connect).toEqual(['self']);
	});
});
