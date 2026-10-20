import { describe, expect, test } from 'bun:test';
import { chooseAdapter, cspOrigins, DEFAULT_API_BASE } from './build-config.ts';

const API = 'https://api.example.com';

describe('chooseAdapter', () => {
	test('a local build uses node', () => {
		expect(chooseAdapter({})).toBe('node');
	});

	test('a Pages build uses cloudflare', () => {
		expect(chooseAdapter({ CF_PAGES: '1', PUBLIC_API_BASE: API })).toBe('cloudflare');
	});

	test('a Workers build uses cloudflare', () => {
		expect(chooseAdapter({ WORKERS_CI: '1', PUBLIC_API_BASE: API })).toBe('cloudflare');
	});

	test('ADAPTER wins over the Cloudflare markers, and can force cloudflare', () => {
		expect(chooseAdapter({ WORKERS_CI: '1', ADAPTER: 'node' })).toBe('node');
		expect(chooseAdapter({ ADAPTER: 'cloudflare', PUBLIC_API_BASE: API })).toBe('cloudflare');
	});

	test('a Cloudflare build without PUBLIC_API_BASE fails', () => {
		expect(() => chooseAdapter({ WORKERS_CI: '1' })).toThrow(
			'PUBLIC_API_BASE must be set for a Cloudflare build',
		);
		expect(() => chooseAdapter({ ADAPTER: 'cloudflare' })).toThrow(
			'PUBLIC_API_BASE must be set for a Cloudflare build',
		);
	});

	test('a node build needs no PUBLIC_API_BASE', () => {
		expect(chooseAdapter({ ADAPTER: 'node' })).toBe('node');
	});

	test('an unknown ADAPTER fails the build', () => {
		expect(() => chooseAdapter({ ADAPTER: 'vercel' })).toThrow(
			'ADAPTER must be node or cloudflare',
		);
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
