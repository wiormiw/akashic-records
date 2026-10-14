import type { AppContainer } from "@/container.ts";
import type { HttpKit, Module } from "./module.ts";

/** Every module, in mount order. The one file that knows them all. */
export async function buildModules(_container: AppContainer, _http: HttpKit): Promise<Module[]> {
  return [];
}
