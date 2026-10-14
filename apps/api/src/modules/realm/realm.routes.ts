import { Hono, type MiddlewareHandler } from "hono";
import * as v from "valibot";
import {
  ApprovedView,
  ArchivedView,
  ArchiveQuery,
  Created,
  CreateRealmBody,
  EditedView,
  FoundedView,
  IdParam,
  JoinedView,
  LeftView,
  MemberView,
  presentMember,
  presentProposal,
  presentRealmSummary,
  presentStanding,
  ProposalView,
  ProposeRealmBody,
  RealmMemberParam,
  RealmSlugParam,
  RealmSummaryView,
  RejectedView,
  RejectProposalBody,
  RoleBody,
  RoleChangedView,
  StandingView,
  UpdateRealmBody,
} from "@akashic/contracts";
import { mapOk } from "@akashic/lib/result";
import { type AppEnv, callerOf } from "@/http/env.ts";
import { type RealmEnv, requirePermission } from "@/http/realm-context.ts";
import { reply, respond } from "@/http/reply.ts";
import type { Sessions } from "@/http/session.ts";
import { validate } from "@/http/validate.ts";
import type { ModuleRoutes } from "../module.ts";
import type { RealmService } from "./realm.service.ts";

const Realms = v.array(RealmSummaryView);
const Members = v.array(MemberView);
const Proposals = v.array(ProposalView);

export function createRealmRoutes(deps: {
  realms: RealmService;
  sessions: Sessions;
  realmContext: MiddlewareHandler<RealmEnv>;
}): ModuleRoutes {
  const { realms, sessions, realmContext } = deps;

  const publicRoutes = new Hono<AppEnv>()
    .get("/realms", async (c) => reply(c, Realms, (await realms.browse()).map(presentRealmSummary)))
    .get("/realms/:slug", validate("param", RealmSlugParam), async (c) =>
      respond(
        c,
        mapOk(await realms.read(c.req.valid("param").slug), presentRealmSummary),
        RealmSummaryView,
      ),
    );

  // Each guard is on its route, not `use`d: a `use` here would also run for every other module's
  // routes under the same path. Validation comes before the guards, as it did in the old API, so
  // a malformed request is a validation failure whoever sends it.
  const realm = new Hono<RealmEnv>()
    .get("/me", realmContext, (c) =>
      reply(c, StandingView, presentStanding(c.var.realm.realmRole, c.var.realm.permissions)),
    )
    .post("/join", realmContext, async (c) =>
      respond(c, await realms.join(c.var.realm.realmId, callerOf(c).id), JoinedView, 201),
    )
    .post("/leave", realmContext, async (c) => {
      const { realmId, realmRole } = c.var.realm;
      return respond(c, await realms.leave(realmId, callerOf(c).id, realmRole), LeftView);
    })
    .patch(
      "/",
      validate("param", RealmSlugParam),
      validate("json", UpdateRealmBody),
      realmContext,
      requirePermission("administer"),
      async (c) =>
        respond(
          c,
          await realms.edit(c.var.realm.realmId, callerOf(c).id, c.req.valid("json")),
          EditedView,
        ),
    )
    .delete(
      "/",
      validate("param", RealmSlugParam),
      validate("query", ArchiveQuery),
      realmContext,
      requirePermission("administer"),
      async (c) =>
        respond(
          c,
          await realms.archive(c.var.realm.realmId, callerOf(c).id, c.req.valid("query").archived),
          ArchivedView,
        ),
    )
    .get("/members", realmContext, requirePermission("participate"), async (c) =>
      reply(c, Members, (await realms.roster(c.var.realm.realmId)).map(presentMember)),
    )
    .patch(
      "/members/:userId",
      validate("param", RealmMemberParam),
      validate("json", RoleBody),
      realmContext,
      requirePermission("vouch"),
      async (c) => {
        const { realmId, realmRole } = c.var.realm;
        const caller = callerOf(c);
        return respond(
          c,
          await realms.changeRole(
            realmId,
            { id: caller.id, role: realmRole },
            c.req.valid("param").userId,
            c.req.valid("json").role,
          ),
          RoleChangedView,
        );
      },
    );

  const review = new Hono<AppEnv>()
    .get("/", sessions.platformAdmin, async (c) =>
      reply(c, Proposals, (await realms.pendingProposals()).map(presentProposal)),
    )
    .post("/:id/approve", validate("param", IdParam), sessions.platformAdmin, async (c) =>
      respond(c, await realms.approve(c.req.valid("param").id, callerOf(c).id), ApprovedView, 201),
    )
    .post(
      "/:id/reject",
      validate("param", IdParam),
      validate("json", RejectProposalBody),
      sessions.platformAdmin,
      async (c) =>
        respond(
          c,
          await realms.reject(c.req.valid("param").id, callerOf(c).id, c.req.valid("json").note),
          RejectedView,
        ),
    );

  const privateRoutes = new Hono<AppEnv>()
    .post("/realms", validate("json", CreateRealmBody), sessions.platformAdmin, async (c) =>
      respond(c, await realms.found(callerOf(c).id, c.req.valid("json")), FoundedView, 201),
    )
    .post("/proposals", validate("json", ProposeRealmBody), async (c) =>
      respond(
        c,
        await realms.propose({ ...c.req.valid("json"), proposedBy: callerOf(c).id }),
        Created,
        201,
      ),
    )
    .get("/proposals/mine", async (c) =>
      reply(c, Proposals, (await realms.myProposals(callerOf(c).id)).map(presentProposal)),
    )
    .route("/realms/:slug", realm)
    .route("/admin/proposals", review);

  return { public: publicRoutes, private: privateRoutes };
}
