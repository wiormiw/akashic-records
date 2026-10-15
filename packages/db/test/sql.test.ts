import { expect, test } from "bun:test";
import {
  centroidFrom,
  containing,
  parseVector,
  pgArray,
  pgVector,
  rowInstant,
} from "@akashic/db/sql";

test("array and vector literals bind as one text parameter", () => {
  expect(pgArray(["a", 'b"c'])).toBe('{"a","b\\"c"}');
  expect(pgVector([0.5, 0.25])).toBe("[0.5,0.25]");
  expect(parseVector("[0.5,0.25]")).toEqual([0.5, 0.25]);
  expect(containing("50%_off")).toBe("%50\\%\\_off%");
});

test("a stored centroid is read as numbers; none means nothing learned", () => {
  expect(centroidFrom({ centroid: "[0.5,0.25]", samples: 4 })).toEqual({
    centroid: [0.5, 0.25],
    samples: 4,
  });
  expect(centroidFrom({ centroid: null, samples: null })).toEqual({ centroid: null, samples: 0 });
  expect(centroidFrom(undefined)).toEqual({ centroid: null, samples: 0 });
});

test("a row timestamp keeps its milliseconds, as a Date or as Postgres text", () => {
  const at = "2026-10-15T12:34:56.789Z";
  expect(rowInstant(new Date(at)).toString()).toBe(at);
  expect(rowInstant("2026-10-15 12:34:56.789123+00").toString()).toBe(at);
  expect(rowInstant("2026-10-15 14:34:56.789+02").toString()).toBe(at);
  expect(rowInstant("2026-10-15 18:04:56.789+05:30").toString()).toBe(at);
  expect(rowInstant(at).toString()).toBe(at);
  // What the old reader did, for the record: Date's text form has no milliseconds.
  expect(new Date(String(new Date(at))).getMilliseconds()).toBe(0);
});
