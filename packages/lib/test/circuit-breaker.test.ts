import { describe, expect, test } from "bun:test";
import { CircuitOpenError, createCircuitBreaker } from "@akashic/lib/circuit-breaker";
import { mutableClock } from "@akashic/lib/time";

// What matters is that an open breaker does not touch the dependency at all, so every test
// counts calls. Time is driven by a mutable clock: nothing sleeps.

function failingDependency() {
  let calls = 0;
  return {
    calls: () => calls,
    run: async () => {
      calls += 1;
      throw new Error("dependency is down");
    },
  };
}

const setup = () => {
  const clock = mutableClock("2026-01-01T00:00:00Z");
  const dependency = failingDependency();
  const seen: string[] = [];
  const breaker = createCircuitBreaker({
    failureThreshold: 3,
    cooldown: { seconds: 30 },
    clock,
    onStateChange: (from, to) => seen.push(`${from}->${to}`),
  });
  const trip = async () => {
    for (let i = 0; i < 3; i += 1) await expect(breaker.run(dependency.run)).rejects.toThrow();
  };
  return { clock, dependency, breaker, seen, trip };
};

describe("circuit breaker", () => {
  test("stays closed below the threshold, and every call reaches the dependency", async () => {
    const { breaker, dependency } = setup();

    for (let i = 0; i < 2; i += 1) await expect(breaker.run(dependency.run)).rejects.toThrow();

    expect(breaker.state()).toBe("closed");
    expect(dependency.calls()).toBe(2);
  });

  test("once open, refuses without calling the dependency", async () => {
    const { breaker, dependency, trip } = setup();
    await trip();

    await expect(breaker.run(dependency.run)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(breaker.run(dependency.run)).rejects.toBeInstanceOf(CircuitOpenError);

    expect(breaker.state()).toBe("open");
    expect(dependency.calls()).toBe(3);
  });

  test("a success resets the failure count", async () => {
    const { breaker, dependency } = setup();

    await expect(breaker.run(dependency.run)).rejects.toThrow();
    await expect(breaker.run(dependency.run)).rejects.toThrow();
    await breaker.run(async () => "ok");
    await expect(breaker.run(dependency.run)).rejects.toThrow();

    expect(breaker.state()).toBe("closed");
  });

  test("lets one probe through exactly when the cooldown ends, and closes on success", async () => {
    const { breaker, dependency, clock, trip } = setup();
    await trip();

    clock.advance({ milliseconds: 29_999 });
    await expect(breaker.run(dependency.run)).rejects.toBeInstanceOf(CircuitOpenError);

    clock.advance({ milliseconds: 1 });
    await expect(breaker.run(async () => "recovered")).resolves.toBe("recovered");
    expect(breaker.state()).toBe("closed");
  });

  test("a failed probe re-opens at once instead of counting to the threshold again", async () => {
    const { breaker, dependency, clock, trip } = setup();
    await trip();
    clock.advance({ seconds: 30 });

    await expect(breaker.run(dependency.run)).rejects.toThrow("dependency is down");
    const afterProbe = dependency.calls();

    await expect(breaker.run(dependency.run)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(breaker.state()).toBe("open");
    expect(dependency.calls()).toBe(afterProbe);
  });

  test("says how long until the next probe", async () => {
    const { breaker, dependency, clock, trip } = setup();
    await trip();
    clock.advance({ seconds: 10 });

    const error = await breaker.run(dependency.run).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CircuitOpenError);
    expect((error as CircuitOpenError).retryAfter.total("seconds")).toBe(20);
  });

  test("announces each state change once, and nothing while refusing", async () => {
    const { breaker, dependency, clock, seen, trip } = setup();
    await trip();
    await expect(breaker.run(dependency.run)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(breaker.run(dependency.run)).rejects.toBeInstanceOf(CircuitOpenError);

    clock.advance({ seconds: 30 });
    await breaker.run(async () => "ok");

    expect(seen).toEqual(["closed->open", "open->half-open", "half-open->closed"]);
  });
});
