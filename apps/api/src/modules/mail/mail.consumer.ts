import * as v from "valibot";
import type { EventHandler } from "@akashic/broker";
import type { Mailer } from "@/integrations/mail.ts";
import { MAIL_REQUESTED, MailRequestedPayload } from "@akashic/contracts";

export function mailHandlers(mailer: Mailer): Record<string, EventHandler> {
  return {
    [MAIL_REQUESTED]: async (payload, _signal, meta) => {
      // A malformed payload throws: it can never succeed, so it retries and is parked for a person.
      const message = v.parse(MailRequestedPayload, payload);
      // The event id is the idempotency key, so a redelivery after a lost ack is not a second email.
      // A failed send throws, which sends the delivery to retry rather than acknowledging it.
      await mailer.send(message, { idempotencyKey: meta.messageId || undefined });
    },
  };
}
