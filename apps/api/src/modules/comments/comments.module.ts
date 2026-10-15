import type { Module } from "../module.ts";
import { createCommentsRoutes } from "./comments.routes.ts";
import type { CommentsModuleDeps } from "./comments.types.ts";

/** Threads under jobs, listings and events. */
export function createCommentsModule(deps: CommentsModuleDeps): Module {
  return { name: "comments", routes: createCommentsRoutes(deps) };
}
