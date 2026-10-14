import { Hono, type MiddlewareHandler } from "hono";
import * as v from "valibot";
import {
  ClearedView,
  Created,
  CreateEventBody,
  EventSummaryView,
  EventView,
  ListEventsQuery,
  presentEvent,
  presentEventSummary,
  RealmItemParam,
  RsvpBody,
  RsvpView,
} from "@akashic/contracts";
import { RealmModule } from "@akashic/lib/enums";
import { mapOk } from "@akashic/lib/result";
import { type AppEnv, callerOf } from "@/http/env.ts";
import { type RealmEnv, requireModule, requirePermission } from "@/http/realm-context.ts";
import { reply, respond } from "@/http/reply.ts";
import type { Sessions } from "@/http/session.ts";
import { validate } from "@/http/validate.ts";
import type { ModuleRoutes } from "../module.ts";
import type { EventService } from "./events.service.ts";

const eventsModule = requireModule(RealmModule.events);

export function createEventsRoutes(deps: {
  events: EventService;
  sessions: Sessions;
  realmContext: MiddlewareHandler<RealmEnv>;
}): ModuleRoutes {
  const { events, realmContext } = deps;

  // Guards sit on each route, after its validation, never `use`d on a shared prefix.
  const publicRoutes = new Hono<RealmEnv>().get(
    "/realms/:slug/events",
    validate("query", ListEventsQuery),
    realmContext,
    eventsModule,
    async (c) => {
      const { when, limit } = c.req.valid("query");
      const list = await events.browse(c.var.realm.realmId, when === "upcoming", limit);
      return reply(c, v.array(EventSummaryView), list.map(presentEventSummary));
    },
  );

  const privateRoutes = new Hono<RealmEnv>()
    .get(
      "/realms/:slug/events/:id",
      validate("param", RealmItemParam),
      realmContext,
      requirePermission("participate"),
      async (c) =>
        respond(
          c,
          mapOk(
            await events.read(c.var.realm.realmId, c.req.valid("param").id, callerOf(c).id),
            presentEvent,
          ),
          EventView,
        ),
    )
    .post(
      "/realms/:slug/events",
      validate("json", CreateEventBody),
      realmContext,
      eventsModule,
      requirePermission("postEvent"),
      async (c) => {
        const body = c.req.valid("json");
        return respond(
          c,
          await events.post({
            ...body,
            realmId: c.var.realm.realmId,
            authorId: callerOf(c).id,
            startsAt: Temporal.Instant.from(body.startsAt),
            endsAt: body.endsAt ? Temporal.Instant.from(body.endsAt) : undefined,
          }),
          Created,
          201,
        );
      },
    )
    .put(
      "/realms/:slug/events/:id/rsvp",
      validate("param", RealmItemParam),
      validate("json", RsvpBody),
      realmContext,
      requirePermission("participate"),
      async (c) =>
        respond(
          c,
          await events.respond(
            c.var.realm.realmId,
            c.req.valid("param").id,
            callerOf(c).id,
            c.req.valid("json").status,
          ),
          RsvpView,
        ),
    )
    .delete(
      "/realms/:slug/events/:id/rsvp",
      validate("param", RealmItemParam),
      realmContext,
      requirePermission("participate"),
      async (c) =>
        respond(
          c,
          await events.withdraw(c.var.realm.realmId, c.req.valid("param").id, callerOf(c).id),
          ClearedView,
        ),
    );

  // Mounted as plain app routes: the realm variable exists only after the guards on each route.
  return {
    public: new Hono<AppEnv>().route("/", publicRoutes),
    private: new Hono<AppEnv>().route("/", privateRoutes),
  };
}
