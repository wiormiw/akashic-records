import type { Executor } from "@akashic/db";
import type { Clock } from "@akashic/lib/time";
import type { Sessions } from "@/http/session.ts";
import type { AdminService } from "./admin.service.ts";

/** What the admin service is built from. */
export interface AdminDeps {
  db: Executor;
  clock: Clock;
}

export type { AdminService };

/** What the admin routes are built from: every route sits behind the platform-admin session. */
export interface AdminRoutesDeps {
  admin: AdminService;
  sessions: Sessions;
}

export type AdminModuleDeps = AdminRoutesDeps;

/** A suspension as asked for. A reason is required to ban; `until` null or absent is indefinite. */
export interface BanRequest {
  banned: boolean;
  reason?: string;
  until?: Temporal.Instant;
}

/** The raw row a raw SQL query returns: columns arrive untyped. */
export type Row = Record<string, unknown>;

/** The realm a grant names. */
export interface RealmRef {
  id: string;
  slug: string;
}

/** The account a grant names. */
export interface AccountRef {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
}
