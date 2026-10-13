import pLimit from "p-limit";

/**
 * `Promise.all` with a ceiling on how many run at once. Results come back in input order.
 * The first rejection wins, like `Promise.all`; use `mapLimitedSettled` to keep partial progress.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  // One in flight is a plain loop; skip the scheduler.
  if (concurrency <= 1) {
    const results: R[] = [];
    for (const [index, item] of items.entries()) results.push(await fn(item, index));
    return results;
  }

  const limit = pLimit(concurrency);
  return Promise.all(items.map((item, index) => limit(() => fn(item, index))));
}

/**
 * Like `mapLimited`, but one failure doesn't discard the rest: every item settles.
 * For draining queues, where one bad row must not lose the other 49.
 */
export async function mapLimitedSettled<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const limit = pLimit(Math.max(concurrency, 1));
  return Promise.allSettled(items.map((item, index) => limit(() => fn(item, index))));
}

/**
 * A limiter shared across many calls, for a ceiling that belongs to a resource (one upstream
 * quota) rather than to one batch. Ten batches each with their own `mapLimited` would run ten
 * times the intended concurrency.
 */
export const createLimiter = (concurrency: number) => pLimit(Math.max(concurrency, 1));
