import { describe, expect, test } from "bun:test";
import { RsvpStatus } from "@akashic/lib/enums";
import { hasRoomFor } from "@/modules/events/events.rules.ts";

describe("event capacity", () => {
  test("only going takes a place, and only a capped event fills", () => {
    expect(hasRoomFor(RsvpStatus.going, 2, { going: 1, already: false })).toBe(true);
    expect(hasRoomFor(RsvpStatus.going, 2, { going: 2, already: false })).toBe(false);
    expect(hasRoomFor(RsvpStatus.going, null, { going: 99, already: false })).toBe(true);
    expect(hasRoomFor(RsvpStatus.interested, 2, { going: 2, already: false })).toBe(true);
  });

  test("someone already going keeps their place in a full event", () => {
    expect(hasRoomFor(RsvpStatus.going, 2, { going: 2, already: true })).toBe(true);
  });
});
