/**
 * Waits for `work`, but stops waiting once `signal` aborts, rejecting with its reason. For calls
 * into a library that takes no AbortSignal: the call itself is not cancelled and may still finish,
 * so the library needs its own timeout too.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    // Handled even when the signal wins, so a late rejection is never unhandled.
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Whether `error` is `signal` having aborted, as opposed to the work failing on its own. */
export const isAbortOf = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true && error === signal.reason;
