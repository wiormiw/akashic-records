import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { cascadeTo, citext, createdAt, primaryId, updatedAt, utcTimestamp } from "./columns.ts";

// better-auth's tables. Property names are the library's contract: it looks fields up by these
// exact names, so a rename fails at sign-in, not at compile time.

export const user = pgTable(
  "user",
  {
    id: primaryId(),
    name: text("name").notNull(),
    email: citext("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    // A suspension keeps the account's data; the reason is shown to the account itself.
    bannedAt: utcTimestamp("banned_at"),
    banReason: text("ban_reason"),
    bannedUntil: utcTimestamp("banned_until"),
    image: text("image"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("ux_user_email").on(table.email),
    // Account search in the admin panel is ILIKE, which needs trigram indexes.
    index("ix_user_name_trgm").using("gin", table.name.op("gin_trgm_ops")),
    index("ix_user_email_trgm").using("gin", table.email.op("gin_trgm_ops")),
  ],
);

export const session = pgTable(
  "session",
  {
    id: primaryId(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: cascadeTo("user_id", () => user.id),
  },
  (table) => [
    uniqueIndex("ux_session_token").on(table.token),
    index("ix_session_user_expiry").on(table.userId, table.expiresAt.desc()),
  ],
);

export const account = pgTable(
  "account",
  {
    id: primaryId(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    // Required by better-auth's schema check even though it never writes it.
    issuer: text("issuer").default("akashic"),
    userId: cascadeTo("user_id", () => user.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: utcTimestamp("access_token_expires_at"),
    refreshTokenExpiresAt: utcTimestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("ux_account_provider").on(table.providerId, table.accountId),
    index("ix_account_user").on(table.userId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: primaryId(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: utcTimestamp("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("ix_verification_identifier").on(table.identifier, table.expiresAt)],
);
