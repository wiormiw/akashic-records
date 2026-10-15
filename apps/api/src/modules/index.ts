import type { AppContainer } from "@/container.ts";
import { createAdminModule } from "./admin/admin.module.ts";
import { createCommentsModule } from "./comments/comments.module.ts";
import { createEventsModule } from "./events/events.module.ts";
import { createGovernanceModule } from "./governance/governance.module.ts";
import { createMailModule } from "./mail/mail.module.ts";
import type { HttpKit, Module } from "./module.ts";
import { createPostingsModule } from "./postings/postings.module.ts";
import { createRealmModule } from "./realm/realm.module.ts";
import { createRoomModule } from "./room/room.module.ts";
import { createUploadModule } from "./upload/upload.module.ts";

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
      realmContext: http.realmContext,
    }),
    createPostingsModule({
      postings: await container.getAsync("postings"),
      realmContext: http.realmContext,
      authorizer: container.get("authorizer"),
    }),
    createCommentsModule({
      comments: await container.getAsync("comments"),
      realmContext: http.realmContext,
    }),
    createGovernanceModule({
      governance: await container.getAsync("governance"),
      realmContext: http.realmContext,
    }),
    createRoomModule({
      services: await container.getAsync("rooms"),
      relay: await container.getAsync("relay"),
      logger: http.logger,
    }),
    createUploadModule({
      uploads: container.get("uploads"),
      limiter: http.limiter,
      trustProxy: http.trustProxy,
      logger: http.logger,
    }),
    createAdminModule({ admin: await container.getAsync("admin"), sessions: http.sessions }),
    createMailModule({ mailer: container.get("mailer") }),
  ];
}
