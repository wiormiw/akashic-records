import type { Executor } from "@akashic/db";
import { createGovernanceServices } from "@/modules/governance/governance.module.ts";
import { createGovernanceRoutes } from "@/modules/governance/governance.routes.ts";
import { testApp } from "../../support/app.ts";
import { clock } from "../../support/fixtures.ts";

/** The governance routes mounted as app.ts mounts them, on `db`. */
export const governanceApp = (db: Executor) =>
  testApp(db, {
    routes: ({ realmContext }) =>
      createGovernanceRoutes({
        governance: createGovernanceServices({ db, clock }),
        realmContext,
      }),
  });
