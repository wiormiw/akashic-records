import { Hono } from "hono";
import * as v from "valibot";
import {
  AccountsQuery,
  AccountView,
  AdminSlugParam,
  AuditQuery,
  AuditView,
  BanBody,
  BanView,
  CountsView,
  GrantBody,
  GrantedView,
  IdParam,
  ListQuery,
  PlatformRealmView,
  presentAccount,
  presentAudit,
  presentCounts,
  presentPlatformRealm,
  presentReport,
  ReportsQuery,
  ReportView,
  ReviewedView,
} from "@akashic/contracts";
import { type AppEnv, callerOf } from "@/http/env.ts";
import { reply, respond } from "@/http/reply.ts";
import { validate } from "@/http/validate.ts";
import type { ModuleRoutes } from "../module.ts";
import type { AdminRoutesDeps } from "./admin.types.ts";

/** `/admin`: answers 404 to anyone without platform authority. */
export function createAdminRoutes(deps: AdminRoutesDeps): ModuleRoutes {
  const { admin, sessions } = deps;
  // First on each route, before validation: to anyone without platform authority every admin
  // path is a 404 like an unknown one, malformed request or not (R15).
  const only = sessions.platformAdmin;

  const privateRoutes = new Hono<AppEnv>()
    .get("/admin", only, async (c) => reply(c, CountsView, presentCounts(await admin.overview())))
    .get("/admin/realms", only, validate("query", ListQuery), async (c) =>
      reply(
        c,
        v.array(PlatformRealmView),
        (await admin.realms(c.req.valid("query").limit)).map(presentPlatformRealm),
      ),
    )
    .post(
      "/admin/realms/:slug/admins",
      only,
      validate("param", AdminSlugParam),
      validate("json", GrantBody),
      async (c) =>
        respond(
          c,
          await admin.grantRealmAdmin(
            c.req.valid("param").slug,
            c.req.valid("json").email,
            callerOf(c).id,
          ),
          GrantedView,
          201,
        ),
    )
    .get("/admin/accounts", only, validate("query", AccountsQuery), async (c) => {
      const { q, limit } = c.req.valid("query");
      return reply(
        c,
        v.array(AccountView),
        (await admin.accounts(q ?? "", limit)).map(presentAccount),
      );
    })
    .post(
      "/admin/accounts/:id/ban",
      only,
      validate("param", IdParam),
      validate("json", BanBody),
      async (c) => {
        const { until, ...ban } = c.req.valid("json");
        return respond(
          c,
          await admin.setBan(c.req.valid("param").id, callerOf(c).id, {
            ...ban,
            until: until ? Temporal.Instant.from(until) : undefined,
          }),
          BanView,
        );
      },
    )
    .get("/admin/audit", only, validate("query", AuditQuery), async (c) => {
      const { limit, entityType } = c.req.valid("query");
      return reply(c, v.array(AuditView), (await admin.audit(limit, entityType)).map(presentAudit));
    })
    .get("/admin/reports", only, validate("query", ReportsQuery), async (c) => {
      const { state, limit } = c.req.valid("query");
      return reply(
        c,
        v.array(ReportView),
        (await admin.reports(state === "open", limit)).map(presentReport),
      );
    })
    .post("/admin/reports/:id/review", only, validate("param", IdParam), async (c) =>
      respond(c, await admin.reviewReport(c.req.valid("param").id, callerOf(c).id), ReviewedView),
    );

  return { private: privateRoutes };
}
