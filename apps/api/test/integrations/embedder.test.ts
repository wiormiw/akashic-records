import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { silentLogger } from '@akashic/lib/log';
import { createEmbedder, EMBEDDING_DIMENSIONS } from '@/integrations/embedder.ts';
import { createModelClient, truncateBytes } from '@/integrations/model-client.ts';

// A stand-in provider on a local port: each test scripts its replies and reads back what was sent.
// Real HTTP, so the client's headers, retries and timeouts are exercised as they run in production.
interface Seen {
	path: string;
	headers: Headers;
	body: Record<string, unknown>;
}
let replies: (() => Response)[] = [];
let seen: Seen[] = [];

const provider = Bun.serve({
	port: 0,
	async fetch(request) {
		seen.push({
			path: new URL(request.url).pathname,
			headers: request.headers,
			body: (await request.json()) as Record<string, unknown>,
		});
		return (replies.shift() ?? (() => new Response('no reply scripted', { status: 500 })))();
	},
});
afterAll(() => provider.stop(true));
beforeEach(() => {
	replies = [];
	seen = [];
});

const baseUrl = `http://localhost:${provider.port}/v1/`;
const json =
	(body: unknown, status = 200) =>
	() =>
		Response.json(body, { status });
const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / EMBEDDING_DIMENSIONS);
const logger = silentLogger();
const options = { apiKey: 'k', baseUrl, model: 'embed-1', timeoutMs: 2000, attempts: 2, logger };
const isUnavailable = (error: unknown) => (error as Error).name === 'AiUnavailableError';

describe('embedder', () => {
	test('is unavailable without a provider, or Gemini without a key, and never calls out', async () => {
		for (const off of [
			createEmbedder({ ...options, provider: undefined }),
			createEmbedder({ ...options, provider: 'gemini', apiKey: undefined }),
		]) {
			expect(off.available).toBe(false);
			expect(await off.embed('a realm about robots')).toBeNull();
		}
		expect(seen).toHaveLength(0);
	});

	test('Gemini: semantic similarity on the first 2000 bytes, keyed by header', async () => {
		const embedder = createEmbedder({ ...options, provider: 'gemini' });
		replies = [json({ embedding: { values: vector } })];

		expect(await embedder.embed(`  ${'é'.repeat(1500)}  `)).toEqual(vector);
		const [call] = seen;
		expect(call?.path).toBe('/v1/models/embed-1:embedContent');
		expect(call?.headers.get('x-goog-api-key')).toBe('k');
		expect(call?.body).toMatchObject({ model: 'models/embed-1', taskType: 'SEMANTIC_SIMILARITY' });
		const content = call?.body.content as { parts: { text: string }[] } | undefined;
		const text = content?.parts[0]?.text ?? '';
		expect(new TextEncoder().encode(text).length).toBe(2000);
	});

	test('OpenAI-compatible: no auth header without a key; blank text costs no call', async () => {
		const embedder = createEmbedder({ ...options, provider: 'openai', apiKey: undefined });
		replies = [json({ data: [{ embedding: vector }] })];
		expect(await embedder.embed('x')).toEqual(vector);
		expect(seen[0]?.path).toBe('/v1/embeddings');
		expect(seen[0]?.headers.get('authorization')).toBeNull();

		expect(await embedder.embed('   ')).toBeNull();
		expect(seen).toHaveLength(1);
	});

	test('a model outage or a wrong-width reply means no fit check, never a blocked post', async () => {
		const embedder = createEmbedder({ ...options, provider: 'openai' });
		replies = [json({ data: [{ embedding: [1, 2, 3] }] })];
		expect(await embedder.embed('x')).toBeNull();

		replies = [json({}, 500), json({}, 500)];
		expect(await embedder.embed('x')).toBeNull();
	});

	test("the caller's own cancellation still propagates", async () => {
		const embedder = createEmbedder({ ...options, provider: 'openai' });
		const controller = new AbortController();
		replies = [
			() => {
				controller.abort();
				return new Response(null, { status: 503 });
			},
		];
		await expect(embedder.embed('x', controller.signal)).rejects.toThrow();
	});
});

describe('model client', () => {
	const client = (attempts = 3) =>
		createModelClient({
			baseUrl: baseUrl.replace(/\/$/, ''),
			headers: {},
			attempts,
			timeoutMs: 2000,
			logger,
		});

	test('retries a 503 and a 429, then returns the answer', async () => {
		replies = [json({}, 503), json({}, 429), json({ ok: true })];
		expect(await client().post<{ ok: boolean }>('p', {})).toEqual({ ok: true });
		expect(seen).toHaveLength(3);
	});

	test("gives up at once on a 4xx that retrying can't fix", async () => {
		replies = [json({ error: 'bad key' }, 401)];
		const failure = await client()
			.post('p', {})
			.catch((error: unknown) => error);
		expect(isUnavailable(failure)).toBe(true);
		expect(String((failure as Error).cause)).toContain('model returned 401');
		expect(seen).toHaveLength(1);
	});

	test('opens the circuit after repeated failures and stops calling', async () => {
		const breaking = client(1);
		for (let i = 0; i < 5; i += 1) {
			replies.push(json({}, 500));
			await breaking.post('p', {}).catch(() => {});
		}
		const calls = seen.length;
		const refused = await breaking.post('p', {}).catch((error: unknown) => error);
		expect(isUnavailable(refused)).toBe(true);
		expect(seen).toHaveLength(calls);
	});
});

describe('truncateBytes', () => {
	test('keeps short text, and never splits a multi-byte character', () => {
		expect(truncateBytes('abc', 10)).toBe('abc');
		expect(truncateBytes('éé', 3)).toBe('é'); // 4 bytes; the second é would be cut in half
		expect(truncateBytes('é', 1)).toBe('');
	});
});
