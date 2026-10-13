import type { Env as HonoEnv } from "hono";
import type { RequestContainer } from "@/container.ts";

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
    /** The request's DI scope. Set under the API prefixes, once the caller is known. */
    di: RequestContainer;
  };
}
