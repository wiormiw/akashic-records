import { Resend } from "resend";
import type { Logger } from "@akashic/lib/log";
import { traced } from "@akashic/lib/tracing";

export interface MailHealth {
  configured: boolean;
  healthy: boolean;
  lastFailure: string | null;
  failedAt: Temporal.Instant | null;
}

/** Transactional email. Never throws: a failed send is recorded and reported, not raised. */
export interface Mailer {
  send(message: { to: string; subject: string; html: string; link?: string }): Promise<void>;
  health(now?: Temporal.Instant): MailHealth;
}

export interface ResendMailerOptions {
  apiKey: string | undefined;
  from: string;
  timeoutMs: number;
  /** Logs the link a message carries, so sign-up works locally without a mail provider. */
  logLinks: boolean;
  logger: Logger;
  /** Aborts an in-flight send on shutdown. */
  signal: AbortSignal;
  /** The Resend client, for tests. Default: one built from `apiKey`. */
  client?: Pick<Resend, "emails">;
}

// How long one failure keeps mail reported as unhealthy: long enough to span a retry, short
// enough that one rejected address doesn't flag the deployment for the rest of its life.
const FAILURE_TTL = Temporal.Duration.from({ minutes: 15 });

export function createResendMailer(options: ResendMailerOptions): Mailer {
  const log = options.logger.child({ component: "mail" });
  const resend = options.client ?? (options.apiKey ? new Resend(options.apiKey) : undefined);

  let lastFailure: string | null = null;
  let failedAt: Temporal.Instant | null = null;

  const note = (failure: string | null) => {
    lastFailure = failure;
    failedAt = failure ? Temporal.Now.instant() : null;
  };

  return {
    health(now = Temporal.Now.instant()) {
      const healthy =
        resend !== undefined &&
        (failedAt === null || Temporal.Instant.compare(failedAt.add(FAILURE_TTL), now) < 0);
      return { configured: resend !== undefined, healthy, lastFailure, failedAt };
    },

    send: (message) =>
      // The span says whether a link was involved, never to whom or what was sent.
      traced("mail.send", { "akashic.mail.has_link": Boolean(message.link) }, () =>
        deliver(message),
      ),
  };

  async function deliver({ to, subject, html, link }: Parameters<Mailer["send"]>[0]) {
    if (options.logLinks && link) log.info({ to, subject, link }, "link that would be emailed");

    if (!resend) {
      note("No mail provider is configured on this deployment.");
      log.warn({ to, subject }, "RESEND_API_KEY unset, mail not sent");
      return;
    }

    try {
      // The SDK takes no AbortSignal, so this bounds how long we wait rather than the request.
      const timeout = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]);
      const { error } = await Promise.race([
        resend.emails.send({ from: options.from, to, subject, html }),
        new Promise<never>((_, reject) => {
          timeout.addEventListener("abort", () => reject(new Error("mail send timed out")), {
            once: true,
          });
        }),
      ]);

      if (error) {
        note(String((error as { message?: string }).message ?? error));
        log.error({ to, subject, err: error }, "resend rejected the message");
        return;
      }
      note(null);
    } catch (error) {
      note(error instanceof Error ? error.message : String(error));
      log.error({ to, subject, err: error }, "mail delivery failed");
    }
  }
}
