import { Queues } from "@akashic/broker";
import type { Module } from "../module.ts";
import { mailHandlers } from "./mail.consumer.ts";
import type { MailModuleDeps } from "./mail.types.ts";

/** Sends the mail other features request through the outbox. No routes. */
export function createMailModule(deps: MailModuleDeps): Module {
  return {
    name: "mail",
    routes: {},
    consumer: { queue: Queues.mail, handlers: mailHandlers(deps.mailer) },
  };
}
