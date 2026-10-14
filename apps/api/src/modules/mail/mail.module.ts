import { Queues } from "@akashic/broker";
import type { Mailer } from "@/integrations/mail.ts";
import type { Module } from "../module.ts";
import { mailHandlers } from "./mail.consumer.ts";

/** Sends the mail other features request through the outbox. No routes. */
export function createMailModule(deps: { mailer: Mailer }): Module {
  return {
    name: "mail",
    routes: {},
    consumer: { queue: Queues.mail, handlers: mailHandlers(deps.mailer) },
  };
}
