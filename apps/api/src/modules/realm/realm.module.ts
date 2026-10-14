import type { MiddlewareHandler } from "hono";
import type { Authorizer } from "@akashic/authz";
import { Queues } from "@akashic/broker";
import type { Logger } from "@akashic/lib/log";
import type { RealmEnv } from "@/http/realm-context.ts";
import type { Sessions } from "@/http/session.ts";
import type { Module } from "../module.ts";
import { createRealmConsumer } from "./realm.consumer.ts";
import { createRealmRoutes } from "./realm.routes.ts";
import type { RealmService } from "./realm.service.ts";

/** Realms, membership and proposals; keeps OpenFGA in step with membership. */
export function createRealmModule(deps: {
  realms: RealmService;
  sessions: Sessions;
  realmContext: MiddlewareHandler<RealmEnv>;
  authorizer: Authorizer;
  logger: Logger;
}): Module {
  return {
    name: "realm",
    routes: createRealmRoutes(deps),
    consumer: {
      queue: Queues.authzSync,
      handlers: createRealmConsumer({ authorizer: deps.authorizer, logger: deps.logger }),
    },
  };
}
