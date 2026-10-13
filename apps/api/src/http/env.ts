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
