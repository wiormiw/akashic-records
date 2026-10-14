import type { Executor } from "@akashic/db";
import { createEventsRoutes } from "@/modules/events/events.routes.ts";
import { createEventService } from "@/modules/events/events.service.ts";
import { testApp } from "../../support/app.ts";
import { clock } from "../../support/fixtures.ts";

/** The events routes mounted as app.ts mounts them, on `db`. */
export const eventsApp = (db: Executor) =>
  testApp(db, {
    routes: ({ realmContext }) =>
      createEventsRoutes({ events: createEventService({ db, clock }), realmContext }),
  });
