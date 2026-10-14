import type { AppContainer } from "@/container.ts";
import { createMailModule } from "./mail/mail.module.ts";
import type { HttpKit, Module } from "./module.ts";

/** Every module, in mount order. The one file that knows them all. */
export async function buildModules(container: AppContainer, _http: HttpKit): Promise<Module[]> {
  return [createMailModule({ mailer: container.get("mailer") })];
}
