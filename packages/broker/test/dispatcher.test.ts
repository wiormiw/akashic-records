import { describe, expect, test } from "bun:test";
import { silentLogger } from "@akashic/lib/log";
import { runDispatcher } from "../src/dispatcher.ts";

// The dispatcher's pacing, with drain and sleep scripted: nothing touches a database or a clock.
// Each drain takes the next step; the run stops once the script is spent.
type Step = number | Error;

async function run(steps: Step[], options: { abortOnError?: boolean } = {}) {
  const controller = new AbortController();
  const slept: number[] = [];
  let drained = 0;

  await runDispatcher({
    drain: async () => {
      const step = steps[drained++];
      if (drained >= steps.length && !(step instanceof Error && options.abortOnError)) {
        controller.abort();
      }
      if (step instanceof Error) {
        if (options.abortOnError) controller.abort();
        throw step;
      }
      return step ?? 0;
    },
    sleep: async (ms) => void slept.push(ms),
    signal: controller.signal,
    batchSize: 10,
    pollMs: 1000,
    log: silentLogger(),
  });

  return { drained, slept };
}

describe("outbox dispatcher", () => {
  test("drains again at once after a full batch, and sleeps a poll after a partial one", async () => {
    expect(await run([10, 10, 3])).toEqual({ drained: 3, slept: [1000] });
  });

  test("backs off five polls after a failure, capped at ten seconds", async () => {
    expect(await run([new Error("db down"), 0])).toEqual({ drained: 2, slept: [5000, 1000] });
  });

  test("stops without backing off when the failure is the shutdown itself", async () => {
    expect(await run([new Error("aborted")], { abortOnError: true })).toEqual({
      drained: 1,
      slept: [],
    });
  });
});
