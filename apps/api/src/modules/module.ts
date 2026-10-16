import type { Hono, MiddlewareHandler } from 'hono';
import type { EventHandler } from '@akashic/broker';
import type { Logger } from '@akashic/lib/log';
import type { AppEnv } from '@/http/env.ts';
import type { RealmEnv } from '@/http/realm-context.ts';
import type { Sessions } from '@/http/session.ts';
import type { RateLimiter } from '@/integrations/rate-limit.ts';

/** Where a module's routes are mounted. */
export interface ModuleRoutes {
	/** Under /api/public/v1: anonymous reads, no session lookup. */
	readonly public?: Hono<AppEnv>;
	/** Under /api/v1, behind the session. */
	readonly private?: Hono<AppEnv>;
	/** At the app root, for routes that own their path, such as a socket. */
	readonly root?: Hono<AppEnv>;
}

/** One feature: its routes, and the events it consumes from its own queue. */
export interface Module {
	readonly name: string;
	readonly routes: ModuleRoutes;
	readonly consumer?: {
		readonly queue: string;
		readonly handlers: Readonly<Record<string, EventHandler>>;
	};
}

/** The HTTP pieces modules share, built once by `start` from the resolved graph. */
export interface HttpKit {
	sessions: Sessions;
	realmContext: MiddlewareHandler<RealmEnv>;
	limiter: RateLimiter;
	trustProxy: boolean;
	logger: Logger;
}
