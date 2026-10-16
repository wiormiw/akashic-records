import { Hono } from 'hono';
import type { Lifecycle } from '@akashic/lib/lifecycle';
import type { Logger } from '@akashic/lib/log';
import type { Auth } from '@/auth/auth.ts';
import { authRoutes } from '@/http/auth-routes.ts';
import type { AppEnv } from '@/http/env.ts';
import { healthRoutes, metaRoutes } from '@/http/meta.ts';
import { notFound, problemHandler } from '@/http/problem.ts';
import { rateLimit } from '@/http/rate-limit.ts';
import { requestContext } from '@/http/request-context.ts';
import { security } from '@/http/security.ts';
import type { Sessions } from '@/http/session.ts';
import type { Mailer } from '@/integrations/mail.ts';
import type { RateLimiter, RateLimitRule } from '@/integrations/rate-limit.ts';
import type { ModuleRoutes } from '@/modules/module.ts';

type Check = () => Promise<boolean>;

export interface AppDeps {
	logger: Logger;
	lifecycle: Lifecycle;
	auth: Auth;
	/** Shared with the modules, which guard their own routes with them. */
	sessions: Sessions;
	mailer: Mailer;
	limiter: RateLimiter;
	limits: { api: RateLimitRule; auth: RateLimitRule; credentials: RateLimitRule };
	allowedOrigins: string[];
	maxBodyBytes: number;
	budgetMs: number;
	trustProxy: boolean;
	checks: { required: Record<string, Check>; optional: Record<string, Check> };
	/** Mounted in this order. */
	modules: readonly ModuleRoutes[];
}

/** The HTTP surface: cross-cutting middleware around the routes each module brings. */
export function createApp(deps: AppDeps) {
	const { session } = deps.sessions;
	const limited = (rule: RateLimitRule) => rateLimit(deps.limiter, rule, deps);

	const publicApi = new Hono<AppEnv>().use(limited({ ...deps.limits.api, bucket: 'public' }));
	const api = new Hono<AppEnv>().use(session).use(limited(deps.limits.api));
	for (const group of deps.modules) {
		if (group.public) publicApi.route('/', group.public);
		if (group.private) api.route('/', group.private);
	}

	const app = new Hono<AppEnv>()
		.use(
			requestContext({
				budgetMs: deps.budgetMs,
				logger: deps.logger,
				lifecycle: deps.lifecycle,
				service: 'akashic',
			}),
		)
		.use(
			security({
				allowedOrigins: deps.allowedOrigins,
				maxBodyBytes: deps.maxBodyBytes,
				largeBodyPaths: ['/api/v1/uploads/'],
			}),
		)
		.route('/', healthRoutes({ lifecycle: deps.lifecycle, ...deps.checks }))
		.route('/', metaRoutes({ service: 'akashic', mailer: deps.mailer }))
		.route(
			'/',
			authRoutes({
				auth: deps.auth,
				limiter: deps.limiter,
				ordinary: deps.limits.auth,
				credentials: deps.limits.credentials,
				trustProxy: deps.trustProxy,
				logger: deps.logger,
			}),
		)
		.route('/api/public/v1', publicApi)
		.route('/api/v1', api);
	// Routes that own their path, such as the room socket, sit outside both API prefixes.
	for (const group of deps.modules) if (group.root) app.route('/', group.root);

	app.onError(problemHandler(deps.logger));
	app.notFound(notFound);
	return app;
}
