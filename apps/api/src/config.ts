import * as v from 'valibot';
import { RoomFrameLimits } from '@akashic/contracts';
import { baseEnv, bool, int, oneOfEnv, optionalUrl, str, url } from '@akashic/lib/config';

/** Deployment settings: what legitimately differs between a laptop and production. */
export const Env = v.object({
	...baseEnv,

	PORT: int({ min: 1, default: 3000 }),
	OTEL_SERVICE_NAME: str({ default: 'akashic' }),

	DATABASE_URL: url(),
	DB_POOL_MAX: int({ min: 1, max: 200, default: 20 }),
	DB_IDLE_TIMEOUT_S: int({ min: 1, default: 30 }),
	DB_CONNECT_TIMEOUT_S: int({ min: 1, default: 10 }),
	// Enforced by Postgres itself, so a slow query or a lock wait gives its connection back instead
	// of holding one of DB_POOL_MAX until it finishes. Under REQUEST_TIMEOUT_MS on purpose.
	DB_STATEMENT_TIMEOUT_MS: int({ min: 0, default: 10_000 }),
	DB_LOCK_TIMEOUT_MS: int({ min: 0, default: 3_000 }),
	DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: int({ min: 0, default: 30_000 }),

	REDIS_URL: optionalUrl(),

	BETTER_AUTH_SECRET: v.pipe(v.string('is required'), v.minLength(32, 'must be at least 32 chars')),
	BETTER_AUTH_URL: url(),
	SESSION_EXPIRY_DAYS: int({ min: 1, default: 30 }),
	SESSION_CACHE_S: int({ min: 0, default: 300 }),

	RESEND_API_KEY: v.optional(v.string()),
	MAIL_FROM: str({ default: 'Akashic Records <onboarding@resend.dev>' }),
	MAIL_TIMEOUT_MS: int({ min: 100, default: 8000 }),

	OUTBOX_DISPATCHER_ENABLED: bool(true),
	OUTBOX_HANDLER_TIMEOUT_MS: int({ min: 100, default: 10000 }),
	OUTBOX_CONCURRENCY: int({ min: 1, max: 64, default: 4 }),
	OUTBOX_BATCH_SIZE: int({ min: 1, max: 1000, default: 50 }),
	OUTBOX_RETENTION_DAYS: int({ min: 1, default: 7 }),
	OUTBOX_POLL_MS: int({ min: 100, default: 1000 }),

	CORS_ORIGINS: str({ default: '' }),
	TRUST_PROXY: bool(false),
	MAX_BODY_BYTES: int({ min: 1024, default: 1048576 }),
	REQUEST_TIMEOUT_MS: int({ min: 100, default: 15000 }),
	RATE_LIMIT_MAX: int({ min: 1, default: 300 }),
	RATE_LIMIT_WINDOW_S: int({ min: 1, default: 60 }),
	AUTH_RATE_LIMIT_MAX: int({ min: 1, default: 10 }),
	AUTH_RATE_LIMIT_WINDOW_S: int({ min: 1, default: 60 }),

	FGA_API_URL: url('http://localhost:8080'),
	// No default: two environments sharing a store share their grants.
	FGA_STORE_ID: str({ minLength: 1 }),
	// Pin in production, or a model pushed mid-rollout changes what running pods authorize.
	FGA_MODEL_ID: v.optional(v.string()),
	// Per request. The SDK retries up to three times, so a dead OpenFGA costs about four of these.
	FGA_TIMEOUT_MS: int({ min: 100, default: 2000 }),

	// Events leave the outbox for this broker; the OpenFGA sync consumes them from it. No default:
	// a wrong one fails silently (the server stays healthy while every event waits), a missing
	// one fails at startup.
	RABBITMQ_URL: url(),
	RABBITMQ_RETRY_DELAY_MS: int({ min: 1000, default: 30_000 }),
	RABBITMQ_MAX_ATTEMPTS: int({ min: 1, max: 50, default: 5 }),

	// Embeddings for realm fit. Without a provider, fit is simply not checked.
	AI_PROVIDER: oneOfEnv(['gemini', 'openai']),
	AI_API_KEY: v.optional(v.string()),
	AI_BASE_URL: optionalUrl(),
	AI_EMBED_MODEL: str({ default: 'gemini-embedding-001' }),
	AI_TIMEOUT_MS: int({ min: 1000, default: 8000 }),
	AI_ATTEMPTS: int({ min: 1, max: 5, default: 2 }),

	// Image uploads. Unset bucket means uploads are refused.
	S3_BUCKET: v.optional(v.string()),
	S3_ENDPOINT: optionalUrl(),
	S3_REGION: str({ default: 'us-east-1' }),
	// Where browsers fetch objects from, which differs from where the API writes them.
	S3_PUBLIC_URL: optionalUrl(),
	// Declared rather than left for Bun.S3Client to find in the environment, so a missing key is a
	// documented setting and not a failed upload.
	S3_ACCESS_KEY_ID: v.optional(v.string()),
	S3_SECRET_ACCESS_KEY: v.optional(v.string()),
});

export type Env = v.InferOutput<typeof Env>;

/** Product rules. Constants, so behaviour can be reproduced from the repository. */
export const policy = {
	pageSize: 50,
	rooms: {
		ticketTtlSeconds: 60,
		roomsPerDay: 20,
		messagesPerMinute: 30,
		// The socket frame schema enforces these; they live with it so both sides agree.
		...RoomFrameLimits,
	},
	uploads: {
		imageTypes: ['image/jpeg', 'image/png', 'image/webp'] as const,
		maxBytes: 5 * 1024 * 1024,
		perHour: 40,
	},
	realmFit: {
		// Cosine distance under which a posting clearly belongs, and over which it clearly doesn't.
		belongs: 0.15,
		doesNotBelong: 0.2,
		// How far one accepted posting moves the centroid.
		learningRate: 0.05,
		// A young realm's centroid is too noisy to refuse anything.
		minSamplesToRefuse: 25,
	},
} as const;

/** The most an upload's request body may be: the file, plus room for the multipart framing. */
export const UPLOAD_BODY_BYTES = policy.uploads.maxBytes + 64 * 1024;
