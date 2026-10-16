import type { Executor } from "@akashic/db";
import { createCommentsRoutes } from "@/modules/comments/comments.routes.ts";
import { createCommentService } from "@/modules/comments/comments.service.ts";
import { testApp } from "../../support/app.ts";
import { clock } from "../../support/fixtures.ts";

/** The comments routes mounted as app.ts mounts them, on `db`. */
export const commentsApp = (db: Executor) =>
  testApp(db, {
    routes: ({ realmContext, authorizer }) =>
      createCommentsRoutes({
        comments: createCommentService({ db, clock }),
        realmContext,
        authorizer,
      }),
  });
