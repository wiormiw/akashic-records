import { Hono } from "hono";
import * as v from "valibot";
import {
  presentRecall,
  presentSeatStanding,
  presentTakedown,
  RealmItemParam,
  RealmMemberParam,
  ReasonBody,
  RecallBody,
  RecallOpenedView,
  RecallTallyView,
  RecallView,
  SeatRemovedView,
  StandingsView,
  TakedownBody,
  TakedownOpenedView,
  TakedownTallyView,
  TakedownView,
  UpvotedView,
  UpvoteWithdrawnView,
  VoteBody,
} from "@akashic/contracts";
import { RealmModule } from "@akashic/lib/enums";
import { policy } from "@/config.ts";
import { type AppEnv, callerOf } from "@/http/env.ts";
import { type RealmEnv, requireModule, requirePermission } from "@/http/realm-context.ts";
import { reply, respond } from "@/http/reply.ts";
import { validate } from "@/http/validate.ts";
import type { ModuleRoutes } from "../module.ts";
import type { GovernanceRoutesDeps } from "./governance.types.ts";

const Recalls = v.array(RecallView);
const Takedowns = v.array(TakedownView);

export function createGovernanceRoutes(deps: GovernanceRoutesDeps): ModuleRoutes {
  const { governance, realmContext } = deps;
  const { seats, recalls, takedowns } = governance;

  // Elections are a module; takedowns work in every realm. Guards sit on each route, after its
  // validation, never `use`d on a shared prefix.
  const elected = [requireModule(RealmModule.election), requirePermission("participate")] as const;
  const moderate = requirePermission("moderate");

  const privateRoutes = new Hono<RealmEnv>()
    .get("/realms/:slug/standings", realmContext, ...elected, async (c) => {
      const standings = await seats.standings(c.var.realm.realmId, policy.pageSize);
      return reply(c, StandingsView, {
        ...standings,
        members: standings.members.map(presentSeatStanding),
      });
    })
    .post(
      "/realms/:slug/members/:userId/upvote",
      validate("param", RealmMemberParam),
      realmContext,
      ...elected,
      async (c) =>
        respond(
          c,
          await seats.upvote(c.var.realm.realmId, callerOf(c).id, c.req.valid("param").userId),
          UpvotedView,
        ),
    )
    .delete(
      "/realms/:slug/members/:userId/upvote",
      validate("param", RealmMemberParam),
      realmContext,
      ...elected,
      async (c) =>
        respond(
          c,
          await seats.withdrawUpvote(
            c.var.realm.realmId,
            callerOf(c).id,
            c.req.valid("param").userId,
          ),
          UpvoteWithdrawnView,
        ),
    )
    .delete(
      "/realms/:slug/members/:userId/seat",
      validate("param", RealmMemberParam),
      validate("json", ReasonBody),
      realmContext,
      requirePermission("administer"),
      async (c) =>
        respond(
          c,
          await seats.removeModerator(
            c.var.realm.realmId,
            c.req.valid("param").userId,
            callerOf(c).id,
            c.req.valid("json").reason,
          ),
          SeatRemovedView,
        ),
    )
    .get("/realms/:slug/recalls", realmContext, ...elected, async (c) =>
      reply(
        c,
        Recalls,
        (await recalls.openRecalls(c.var.realm.realmId, policy.pageSize)).map(presentRecall),
      ),
    )
    .post(
      "/realms/:slug/recalls",
      validate("json", RecallBody),
      realmContext,
      ...elected,
      async (c) => {
        const body = c.req.valid("json");
        return respond(
          c,
          await recalls.proposeRecall(
            c.var.realm.realmId,
            body.userId,
            body.kind,
            body.reason,
            callerOf(c).id,
          ),
          RecallOpenedView,
          201,
        );
      },
    )
    .post(
      "/realms/:slug/recalls/:id/vote",
      validate("param", RealmItemParam),
      validate("json", VoteBody),
      realmContext,
      ...elected,
      async (c) =>
        respond(
          c,
          await recalls.voteOnRecall(
            c.var.realm.realmId,
            c.req.valid("param").id,
            callerOf(c).id,
            c.req.valid("json").agree,
          ),
          RecallTallyView,
        ),
    )
    .get("/realms/:slug/takedowns", realmContext, moderate, async (c) =>
      reply(
        c,
        Takedowns,
        (await takedowns.openTakedowns(c.var.realm.realmId, policy.pageSize)).map(presentTakedown),
      ),
    )
    .post(
      "/realms/:slug/takedowns",
      validate("json", TakedownBody),
      realmContext,
      moderate,
      async (c) => {
        const body = c.req.valid("json");
        return respond(
          c,
          await takedowns.proposeTakedown(
            c.var.realm.realmId,
            body.commentId,
            body.reason,
            callerOf(c).id,
          ),
          TakedownOpenedView,
          201,
        );
      },
    )
    .post(
      "/realms/:slug/takedowns/:id/vote",
      validate("param", RealmItemParam),
      validate("json", VoteBody),
      realmContext,
      moderate,
      async (c) =>
        respond(
          c,
          await takedowns.voteOnTakedown(
            c.var.realm.realmId,
            c.req.valid("param").id,
            callerOf(c).id,
            c.req.valid("json").agree,
          ),
          TakedownTallyView,
        ),
    );

  return { private: new Hono<AppEnv>().route("/", privateRoutes) };
}
