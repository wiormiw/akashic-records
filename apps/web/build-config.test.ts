import { describe, expect, test } from 'bun:test';
import { chooseAdapter, cspOrigins, DEFAULT_API_BASE } from './build-config.ts';

const API = 'https://api.example.com';

describe('chooseAdapter', () => {
	test('a local build uses node', () => {
		expect(chooseAdapter({})).toBe('node');
	});

	test('a Vercel build uses vercel', () => {
		expect(chooseAdapter({ VERCEL: '1', PUBLIC_API_BASE: API })).toBe('vercel');
	});

	test('ADAPTER wins over VERCEL', () => {
		expect(chooseAdapter({ VERCEL: '1', ADAPTER: 'node', PUBLIC_API_BASE: API })).toBe('node');
	});

	test('a Vercel build without PUBLIC_API_BASE fails', () => {
		expect(() => chooseAdapter({ VERCEL: '1' })).toThrow(
			'PUBLIC_API_BASE must be set for a Vercel build',
		);
		expect(chooseAdapter({ VERCEL: '1', PUBLIC_API_BASE: 'https://api.example.com' })).toBe(
			'vercel',
		);
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

	test('no API base defaults to the one config.ts uses', () => {
		expect(DEFAULT_API_BASE).toBe('http://localhost:3000');
		expect(cspOrigins({}).connect).toEqual(['self', 'ws://localhost:3000']);
	});
});
