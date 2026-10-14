import * as v from "valibot";
import type { DomainEvent } from "@akashic/db";

/** Stored in outbox rows and on the wire: never rename. */
export const MAIL_REQUESTED = "mail.requested";

export const MailRequestedPayload = v.object({
  to: v.pipe(v.string(), v.minLength(1)),
  subject: v.string(),
  html: v.string(),
  link: v.nullable(v.string()),
});
export type MailRequested = v.InferOutput<typeof MailRequestedPayload>;

export const mailRequested = (message: MailRequested): DomainEvent => ({
  type: MAIL_REQUESTED,
  payload: message,
});
