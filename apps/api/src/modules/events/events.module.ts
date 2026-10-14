import type { MiddlewareHandler } from "hono";
import type { RealmEnv } from "@/http/realm-context.ts";
import type { Sessions } from "@/http/session.ts";
import type { Module } from "../module.ts";
import { createEventsRoutes } from "./events.routes.ts";
import type { EventService } from "./events.service.ts";

/** Events in a realm: posting, reading, and who is coming. */
export function createEventsModule(deps: {
  events: EventService;
  sessions: Sessions;
  realmContext: MiddlewareHandler<RealmEnv>;
}): Module {
  return { name: "events", routes: createEventsRoutes(deps) };
}
