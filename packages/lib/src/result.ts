import type { AppError } from "./errors.ts";

/**
 * What a service returns when it can fail in a way the caller should handle: a value, or the
 * AppError saying why not. `throw` is left for bugs and infrastructure failing.
 */
export type Result<T, E = AppError> = Ok<T> | Err<E>;
export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

/** Transforms a success, passing a failure through untouched: for presenting it at an edge. */
export const mapOk = <T, U, E>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> =>
  result.ok ? ok(transform(result.value)) : result;
