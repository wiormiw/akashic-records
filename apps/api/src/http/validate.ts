import { sValidator } from "@hono/standard-validator";
import type { ValidationTargets } from "hono";
import type * as v from "valibot";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { problemResponse } from "./problem.ts";

/** Validates one part of the request with a contract schema; a failure is the usual problem. */
export const validate = <T extends keyof ValidationTargets, S extends v.GenericSchema>(
  target: T,
  schema: S,
) =>
  sValidator(target, schema, (result, c) => {
    if (result.success) return;
    return problemResponse(
      c as never,
      fail.validation(ErrorCode.common.validation, "Invalid request.", {
        details: {
          issues: result.error.map((issue) => ({
            path: (issue.path ?? [])
              .map((p) => String(typeof p === "object" ? p.key : p))
              .join("."),
            message: issue.message,
          })),
        },
      }),
    );
  });
