import type { Logger } from "@akashic/lib/log";
import { traced } from "@akashic/lib/tracing";
import { createModelClient, truncateBytes, type ModelClient } from "./model-client.ts";

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

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const MAX_INPUT_BYTES = 2000;

export interface EmbedderOptions {
  provider: "gemini" | "openai" | undefined;
  apiKey: string | undefined;
  baseUrl: string | undefined;
  model: string;
  timeoutMs: number;
  attempts: number;
  logger: Logger;
}

/** The configured provider's embedder, or one that is unavailable when none is configured. */
export function createEmbedder(options: EmbedderOptions): Embedder {
  const log = options.logger.child({ component: "embedder" });
  const { apiKey } = options;
  const provider = options.provider && providers[options.provider];

  if (!provider || (provider.requiresKey && !apiKey)) {
    log.warn("no embedding model configured: realm fit will not be checked");
    return { available: false, embed: () => Promise.resolve(null) };
  }

  const client = createModelClient({
    baseUrl: (options.baseUrl ?? provider.baseUrl).replace(/\/+$/, ""),
    headers: apiKey ? provider.auth(apiKey) : {},
    attempts: options.attempts,
    timeoutMs: options.timeoutMs,
    logger: log,
  });
  const request = provider.request(client, options.model);

  return {
    available: true,
    async embed(text, signal) {
      const input = truncateBytes(text.trim(), MAX_INPUT_BYTES);
      if (!input) return null;
      try {
        const vector = await traced(
          "embedder.embed",
          { "akashic.ai.provider": options.provider, "akashic.ai.model": options.model },
          () => request(input, signal),
          { signal },
        );
        return vector?.length === EMBEDDING_DIMENSIONS ? vector : null;
      } catch (error) {
        if (signal?.aborted) throw error;
        // Fit is a courtesy check; a model outage must not block posting.
        log.warn({ err: error }, "embedding failed, fit not checked");
        return null;
      }
    },
  };
}

type Request = (input: string, signal?: AbortSignal) => Promise<number[] | undefined>;

const gemini =
  (client: ModelClient, model: string): Request =>
  async (input, signal) => {
    const reply = await client.post<{ embedding?: { values?: number[] } }>(
      `models/${model}:embedContent`,
      {
        model: `models/${model}`,
        content: { parts: [{ text: input }] },
        taskType: "SEMANTIC_SIMILARITY",
        outputDimensionality: EMBEDDING_DIMENSIONS,
      },
      signal,
    );
    return reply.embedding?.values;
  };

const openAi =
  (client: ModelClient, model: string): Request =>
  async (input, signal) => {
    const reply = await client.post<{ data?: { embedding?: number[] }[] }>(
      "embeddings",
      { model, input, dimensions: EMBEDDING_DIMENSIONS },
      signal,
    );
    return reply.data?.[0]?.embedding;
  };

// What each provider needs beyond the shared model client. OpenAI-compatible servers (Ollama,
// vLLM) often run without a key, so only Gemini insists on one.
const providers = {
  gemini: {
    baseUrl: GEMINI_BASE_URL,
    requiresKey: true,
    auth: (key: string) => ({ "x-goog-api-key": key }),
    request: gemini,
  },
  openai: {
    baseUrl: OPENAI_BASE_URL,
    requiresKey: false,
    auth: (key: string) => ({ authorization: `Bearer ${key}` }),
    request: openAi,
  },
} as const;
