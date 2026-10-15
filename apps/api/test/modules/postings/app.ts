import type { Executor } from "@akashic/db";
import type { Embedder } from "@/integrations/embedder.ts";
import { createPostingsRoutes } from "@/modules/postings/postings.routes.ts";
import { createPostingServices } from "@/modules/postings/postings.module.ts";
import { testApp } from "../../support/app.ts";
import { clock } from "../../support/fixtures.ts";
import { embedderOf } from "./fixtures.ts";

/** The postings routes mounted as app.ts mounts them, on `db`. */
export const postingsApp = (db: Executor, embedder: Embedder = embedderOf()) =>
  testApp(db, {
    routes: ({ realmContext, authorizer }) =>
      createPostingsRoutes({
        postings: createPostingServices({ db, embedder, clock }),
        realmContext,
        authorizer,
      }),
  });
