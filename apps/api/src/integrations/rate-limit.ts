import type { Counter, CounterStore } from "./counters.ts";

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
  /** Namespaces the key, so a tight per-route budget can't spend a broad per-caller one. */
  readonly bucket: string;
}

export interface RateLimiter {
  /** Counts one request. Undefined when no counter could answer: the caller should allow it. */
  hit(rule: RateLimitRule, caller: string, now?: Temporal.Instant): Promise<Counter | undefined>;
}

/** Keys and counts; where the counts live is the store's business. The middleware is the API's. */
export function createRateLimiter(options: { counters: CounterStore }): RateLimiter {
  const { counters } = options;
  return {
    hit: (rule, caller, now = Temporal.Now.instant()) =>
      counters.increment(`rl:${rule.bucket}:${caller}`, rule.windowSeconds, now),
  };
}
