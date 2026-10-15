import type { Mailer } from "@/integrations/mail.ts";

/** What the mail module is built from. */
export interface MailModuleDeps {
  mailer: Mailer;
}
