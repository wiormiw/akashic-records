import { expect } from "bun:test";
import type { AppError } from "@akashic/lib/errors";
import type { Result } from "@akashic/lib/result";

/** The value of a Result that must have succeeded; fails the test with the error otherwise. */
export function expectOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** The AppError of a Result that must have failed with `code`. */
export function expectErr<T>(result: Result<T>, code: string): AppError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe(code);
  return result.error;
}
