import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import type { Db } from "@akashic/db";
import type { Logger } from "@akashic/lib/log";
import type { Mailer } from "@/integrations/mail.ts";
import { banMessage, banOf } from "./bans.ts";

export interface AuthOptions {
  appName: string;
  /** Browsers scope cookies by host, not port: two apps on localhost need different prefixes. */
  cookiePrefix: string;
  db: Db;
  secret: string;
  baseUrl: string;
  /** Front-end origins. The first is where verification links land. */
  trustedOrigins: string[];
  mailer: Mailer;
  sessionExpiryDays: number;
  sessionCacheS: number;
  secureCookies: boolean;
  logger: Logger;
}

export function createAuth(options: AuthOptions) {
  const log = options.logger.child({ component: "auth" });
  const { appName, mailer } = options;

  // better-auth's links point at the API; send the reader on to the front end afterwards.
  const toFrontEnd = (url: string): string => {
    const frontEnd = options.trustedOrigins[0];
    if (!frontEnd) return url;
    const link = new URL(url);
    link.searchParams.set("callbackURL", `${frontEnd}/verified`);
    return link.toString();
  };

  return betterAuth({
    appName,
    secret: options.secret,
    baseURL: options.baseUrl,
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(options.db, { provider: "pg", usePlural: false }),

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: ({ user, url }) =>
        mailer.send({
          to: user.email,
          subject: `Reset your ${appName} password`,
          html: `<p>Reset your password: <a href="${url}">${url}</a></p><p>Ignore this if it wasn't you.</p>`,
          link: url,
        }),
    },

    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: ({ user, url }) => {
        const link = toFrontEnd(url);
        return mailer.send({
          to: user.email,
          subject: `Verify your ${appName} email`,
          html: `<p>Confirm your address: <a href="${link}">${link}</a></p>`,
          link,
        });
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * options.sessionExpiryDays,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: options.sessionCacheS },
    },

    databaseHooks: {
      session: {
        create: {
          // A suspended account can't start a session.
          before: async (session) => {
            const ban = await banOf(options.db, session.userId);
            if (!ban) return;
            log.info({ userId: session.userId }, "refused sign-in for a suspended account");
            throw new APIError("FORBIDDEN", {
              code: "ACCOUNT_SUSPENDED",
              message: banMessage(ban),
            });
          },
        },
      },
    },

    advanced: {
      cookiePrefix: options.cookiePrefix,
      database: { generateId: () => Bun.randomUUIDv7() },
      useSecureCookies: options.secureCookies,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
