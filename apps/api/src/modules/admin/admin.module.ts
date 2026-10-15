import type { Module } from "../module.ts";
import { createAdminRoutes } from "./admin.routes.ts";
import type { AdminModuleDeps } from "./admin.types.ts";

/** The platform's control panel. */
export function createAdminModule(deps: AdminModuleDeps): Module {
  return { name: "admin", routes: createAdminRoutes(deps) };
}
