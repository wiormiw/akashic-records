import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as v from "valibot";
import type { Result } from "@akashic/lib/result";
import type { AppEnv } from "./env.ts";
import { problemResponse } from "./problem.ts";

/**
 * Sends `value` as `view` describes it. Parsing drops keys the view doesn't declare, so a column
 * added to a query never reaches the wire; a value the view rejects throws, and is our bug.
 */
export function reply<S extends v.GenericSchema>(
  c: Context<AppEnv>,
  view: S,
  value: v.InferInput<S>,
  status: ContentfulStatusCode = 200,
): Response {
  return c.json(v.parse(view, value) as object, status);
}

/** A service's Result as the answer: the value through `view`, or the problem a throw would be. */
export function respond<S extends v.GenericSchema>(
  c: Context<AppEnv>,
  result: Result<v.InferInput<S>>,
  view: S,
  status: ContentfulStatusCode = 200,
): Response {
  return result.ok ? reply(c, view, result.value, status) : problemResponse(c, result.error);
}
