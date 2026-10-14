import type { AppContainer } from "@/container.ts";
import { createEventsModule } from "./events/events.module.ts";
import { createMailModule } from "./mail/mail.module.ts";
import type { HttpKit, Module } from "./module.ts";
import { createRealmModule } from "./realm/realm.module.ts";

/** Every module, in mount order. The one file that knows them all. */
export async function buildModules(container: AppContainer, http: HttpKit): Promise<Module[]> {
  return [
    createRealmModule({
      realms: await container.getAsync("realms"),
      sessions: http.sessions,
      realmContext: http.realmContext,
      authorizer: container.get("authorizer"),
      logger: http.logger,
    }),
    createEventsModule({
      events: await container.getAsync("events"),
      sessions: http.sessions,
      realmContext: http.realmContext,
    }),
    createMailModule({ mailer: container.get("mailer") }),
  ];
}
