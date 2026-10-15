import { Queues } from "@akashic/broker";
import type { Module } from "../module.ts";
import { createRealmConsumer } from "./realm.consumer.ts";
import { createRealmRoutes } from "./realm.routes.ts";
import type { RealmModuleDeps } from "./realm.types.ts";

/** Realms, membership and proposals; keeps OpenFGA in step with membership. */
export function createRealmModule(deps: RealmModuleDeps): Module {
  return {
    name: "realm",
    routes: createRealmRoutes(deps),
    consumer: {
      queue: Queues.authzSync,
      handlers: createRealmConsumer({
        realms: deps.realms,
        authorizer: deps.authorizer,
        logger: deps.logger,
      }),
    },
  };
}
