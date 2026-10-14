import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CommentSubject } from "@akashic/lib/enums";
import {
  ListLimit,
  Slug,
  Timestamp,
  iso,
  oneOf,
  subjectOf,
  trimmed,
  trimmedAsSent,
} from "@akashic/contracts";

describe("contracts", () => {
  test("a timestamp at nanosecond precision is a valid date-time", () => {
    const at = iso(Temporal.Instant.from("2026-06-01T12:00:00.123456789Z"));
    expect(v.parse(Timestamp, at)).toBe("2026-06-01T12:00:00.123456789Z");
  });

  test("a query limit accepts the string a URL carries, with a default", () => {
    expect(v.parse(ListLimit, "5")).toBe(5);
    expect(v.parse(ListLimit, undefined)).toBe(20);
    expect(v.safeParse(ListLimit, "500").success).toBe(false);
  });

  test("trimmed measures its minimum after trimming", () => {
    expect(v.parse(trimmed({ minLength: 3 }), "  abc  ")).toBe("abc");
    expect(v.safeParse(trimmed({ minLength: 3 }), "  ab  ").success).toBe(false);
  });

  test("trimmedAsSent measures its maximum as sent and its minimum after trimming", () => {
    const field = trimmedAsSent({ minLength: 3, maxLength: 6 });
    expect(v.parse(field, " abc ")).toBe("abc");
    expect(v.safeParse(field, "  abc  ").success).toBe(false);
    expect(v.safeParse(field, "  ab ").success).toBe(false);
  });

  test("oneOf accepts exactly an enum's values", () => {
    expect(v.parse(oneOf(CommentSubject), 1)).toBe(1);
    expect(v.safeParse(oneOf(CommentSubject), 9).success).toBe(false);
  });

  test("slugs and subjects", () => {
    expect(v.safeParse(Slug, "print-makers").success).toBe(true);
    expect(v.safeParse(Slug, "Print--makers").success).toBe(false);
    expect(subjectOf({ kind: "jobs", id: "x" })).toEqual({ kind: CommentSubject.job, id: "x" });
  });
});
