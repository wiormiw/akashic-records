import type { Logger } from '@akashic/lib/log';
import { traced } from '@akashic/lib/tracing';
import { createModelClient, truncateBytes } from './model-client.ts';

/**
 * Width of every embedding. Part of the contract: an embedder must produce exactly this many
 * numbers, and the vector columns are declared with it, so changing it needs a migration.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** Turns text into a vector. Optional infrastructure: callers carry on without one. */
export interface Embedder {
	readonly available: boolean;
	/** Null when the model is unavailable or not configured. */
	embed(text: string, signal?: AbortSignal): Promise<number[] | null>;
}

const MAX_INPUT_BYTES = 2000;

export interface EmbedderOptions {
	provider: keyof typeof providers | undefined;
	apiKey: string | undefined;
	baseUrl: string | undefined;
	model: string;
	timeoutMs: number;
	attempts: number;
	logger: Logger;
}

/** The configured provider's embedder, or one that is unavailable when none is configured. */
export function createEmbedder(options: EmbedderOptions): Embedder {
	const log = options.logger.child({ component: 'embedder' });
	const { apiKey, model } = options;
	const provider = options.provider && providers[options.provider];

	if (!provider || (provider.requiresKey && !apiKey)) {
		log.warn('no embedding model configured: realm fit will not be checked');
		return { available: false, embed: () => Promise.resolve(null) };
	}

	const auth = provider.auth ?? bearer;
	const client = createModelClient({
		baseUrl: (options.baseUrl ?? provider.baseUrl).replace(/\/+$/, ''),
		headers: apiKey ? auth(apiKey) : {},
		attempts: options.attempts,
		timeoutMs: options.timeoutMs,
		logger: log,
	});

	return {
		available: true,
		async embed(text, signal) {
			const input = truncateBytes(text.trim(), MAX_INPUT_BYTES);
			if (!input) return null;
			try {
				const vector = await traced(
					'embedder.embed',
					{ 'akashic.ai.provider': options.provider, 'akashic.ai.model': model },
					async () =>
						provider.vector(
							await client.post(provider.path(model), provider.body(input, model), signal),
						),
					{ signal },
				);
				return vector?.length === EMBEDDING_DIMENSIONS ? vector : null;
			} catch (error) {
				if (signal?.aborted) throw error;
				// Fit is a courtesy check; a model outage must not block posting.
				log.warn({ err: error }, 'embedding failed, fit not checked');
				return null;
			}
		},
	};
}

/** Everything one embedding API needs: where it lives, what it is sent, where the vector is. */
interface Provider<Reply = unknown> {
	baseUrl: string;
	requiresKey: boolean;
	/** Headers carrying the key; a Bearer token when left out. */
	auth?: (key: string) => Record<string, string>;
	path: (model: string) => string;
	body: (input: string, model: string) => unknown;
	// Method syntax on purpose: its parameter is bivariant, so each provider types its own reply
	// and still fits the one `Provider` the embedder calls.
	vector(reply: Reply): number[] | undefined;
}

const defineProvider = <Reply>(provider: Provider<Reply>): Provider => provider;

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

// OpenAI-compatible servers (Ollama, vLLM) often run without a key, so only Gemini insists on one.
const providers = {
	gemini: defineProvider<{ embedding?: { values?: number[] } }>({
		baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
		requiresKey: true,
		auth: (key) => ({ 'x-goog-api-key': key }),
		path: (model) => `models/${model}:embedContent`,
		body: (text, model) => ({
			model: `models/${model}`,
			content: { parts: [{ text }] },
			taskType: 'SEMANTIC_SIMILARITY',
			outputDimensionality: EMBEDDING_DIMENSIONS,
		}),
		vector: (reply) => reply.embedding?.values,
	}),
	openai: defineProvider<{ data?: { embedding?: number[] }[] }>({
		baseUrl: 'https://api.openai.com/v1',
		requiresKey: false,
		path: () => 'embeddings',
		body: (input, model) => ({ model, input, dimensions: EMBEDDING_DIMENSIONS }),
		vector: (reply) => reply.data?.[0]?.embedding,
	}),
};
