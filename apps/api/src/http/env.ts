import type { Env as HonoEnv } from "hono";

export interface Caller {
  readonly id: string;
  readonly email: string;
}

/** What every request carries, set by middleware before any route runs. */
export interface AppEnv extends HonoEnv {
  Variables: {
    requestId: string;
    /** Aborts on client disconnect, the request deadline, or shutdown. */
    signal: AbortSignal;
    user: Caller | null;
  };
}

/**
 * The caller on a route behind `session`, which has already refused anyone signed out. A missing
 * caller here means the route was mounted outside the session: a bug, so it throws.
 */
export function callerOf(c: { var: { user: Caller | null } }): Caller {
  if (!c.var.user) throw new Error("a signed-in route ran without a caller");
  return c.var.user;
}
