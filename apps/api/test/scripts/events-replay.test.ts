import { expect, test } from "bun:test";
import { Queues } from "@akashic/broker";
import { QUEUES } from "../../scripts/events-replay.ts";

test("the replay covers every consumer queue, a new one included", () => {
  expect([...QUEUES].sort()).toEqual(Object.values(Queues).sort());
  expect(QUEUES).toContain("akashic.authz-sync");
  expect(QUEUES).toContain("akashic.mail");
});
