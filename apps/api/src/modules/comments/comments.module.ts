import type { MiddlewareHandler } from "hono";
import type { RealmEnv } from "@/http/realm-context.ts";
import type { Module } from "../module.ts";
import { createCommentsRoutes } from "./comments.routes.ts";
import type { CommentService } from "./comments.service.ts";

/** Threads under jobs, listings and events. */
export function createCommentsModule(deps: {
  comments: CommentService;
  realmContext: MiddlewareHandler<RealmEnv>;
}): Module {
  return { name: "comments", routes: createCommentsRoutes(deps) };
}
