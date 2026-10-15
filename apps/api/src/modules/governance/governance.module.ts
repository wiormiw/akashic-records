import type { Module } from "../module.ts";
import { createRecallService } from "./governance.recalls.service.ts";
import { createGovernanceRoutes } from "./governance.routes.ts";
import { createSeatService } from "./governance.seats.service.ts";
import { createTakedownService } from "./governance.takedowns.service.ts";
import type {
  GovernanceDeps,
  GovernanceModuleDeps,
  GovernanceServices,
} from "./governance.types.ts";

/** The governance services, built once: a carried recall unseats through the seats service. */
export function createGovernanceServices(deps: GovernanceDeps): GovernanceServices {
  const seats = createSeatService(deps);
  return {
    seats,
    recalls: createRecallService({ ...deps, seats }),
    takedowns: createTakedownService(deps),
  };
}

/** Elected moderators, recalls and takedowns. */
export function createGovernanceModule(deps: GovernanceModuleDeps): Module {
  return { name: "governance", routes: createGovernanceRoutes(deps) };
}
