import { expect, test } from "bun:test";
import { fixedClock, fromDate, isBefore, toDate } from "@akashic/lib/time";

test("instants round-trip through Date at millisecond precision", () => {
  const at = fixedClock("2026-06-01T12:00:00.123Z").now();
  expect(fromDate(toDate(at)).equals(at)).toBe(true);
  expect(isBefore(at, at.add({ seconds: 1 }))).toBe(true);
});
