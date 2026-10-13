import { inferdiHono } from "@inferdi/hono";
import { Hono } from "hono";
import type { Authorizer } from "@akashic/authz";
import type { Db } from "@akashic/db";
import type { Lifecycle } from "@akashic/lib/lifecycle";
import type { Logger } from "@akashic/lib/log";
import type { Auth } from "@/auth/auth.ts";
import { requestScope, type AppContainer, type RequestContainer } from "@/container.ts";
import { authRoutes } from "@/http/auth-routes.ts";
import type { AppEnv } from "@/http/env.ts";
import { healthRoutes, metaRoutes } from "@/http/meta.ts";
import { notFound, problemHandler } from "@/http/problem.ts";
import { rateLimit } from "@/http/rate-limit.ts";
import { requestContext } from "@/http/request-context.ts";
import { security } from "@/http/security.ts";
import { sessions } from "@/http/session.ts";
import type { Mailer } from "@/integrations/mail.ts";
import type { RateLimiter, RateLimitRule } from "@/integrations/rate-limit.ts";

/**
 * What routes under the API prefixes carry: the request's DI scope, opened once the caller is
 * known. Root routes are plain `AppEnv`, so they can't assume a scope that isn't there.
 */
export interface ApiEnv extends AppEnv {
  Variables: AppEnv["Variables"] & { di: RequestContainer };
}

/** Where a module's routes are mounted. */
export interface ModuleRoutes {
  /** Under the public API: anonymous reads, no session lookup. */
  readonly public?: Hono<ApiEnv>;
  /** Under the signed-in API. */
  readonly private?: Hono<ApiEnv>;
  /** At the app root, for routes that own their path, such as a socket. */
  readonly root?: Hono<AppEnv>;
}

type Check = () => Promise<boolean>;

export interface AppDeps {
  container: AppContainer;
  logger: Logger;
  lifecycle: Lifecycle;
  auth: Auth;
  db: Db;
  authorizer: Authorizer;
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
  const { session } = sessions({ auth: deps.auth, db: deps.db, authorizer: deps.authorizer });
  // One scope per request, opened after the caller is known so services resolved from it see them.
  const scoped = inferdiHono<AppContainer, ApiEnv, RequestContainer>({
    container: deps.container,
    createScope: (root, c) =>
      requestScope(root, { id: c.get("requestId"), signal: c.get("signal"), user: c.get("user") }),
  });
  const limited = (rule: RateLimitRule) => rateLimit(deps.limiter, rule, deps);

  const publicApi = new Hono<ApiEnv>()
    .use(limited({ ...deps.limits.api, bucket: "public" }))
    .use(scoped);
  const api = new Hono<ApiEnv>().use(session).use(limited(deps.limits.api)).use(scoped);
  for (const group of deps.modules) {
    if (group.public) publicApi.route("/", group.public);
    if (group.private) api.route("/", group.private);
  }

  const app = new Hono<AppEnv>()
    .use(
      requestContext({
        budgetMs: deps.budgetMs,
        logger: deps.logger,
        lifecycle: deps.lifecycle,
        service: "akashic",
      }),
    )
    .use(
      security({
        allowedOrigins: deps.allowedOrigins,
        maxBodyBytes: deps.maxBodyBytes,
        largeBodyPaths: ["/api/v1/uploads/"],
      }),
    )
    .route("/", healthRoutes({ lifecycle: deps.lifecycle, ...deps.checks }))
    .route("/", metaRoutes({ service: "akashic", mailer: deps.mailer }))
    .route(
      "/",
      authRoutes({
        auth: deps.auth,
        limiter: deps.limiter,
        ordinary: deps.limits.auth,
        credentials: deps.limits.credentials,
        trustProxy: deps.trustProxy,
        logger: deps.logger,
      }),
    )
    .route("/api/public/v1", publicApi)
    .route("/api/v1", api);
  // Routes that own their path, such as the room socket, sit outside both API prefixes.
  for (const group of deps.modules) if (group.root) app.route("/", group.root);

  app.onError(problemHandler(deps.logger));
  app.notFound(notFound);
  return app;
}
