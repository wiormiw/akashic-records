import { expect, test } from "bun:test";
import { centroidFrom, containing, parseVector, pgArray, pgVector } from "@akashic/db/sql";

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
