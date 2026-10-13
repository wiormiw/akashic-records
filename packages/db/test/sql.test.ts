import { expect, test } from "bun:test";
import { containing, parseVector, pgArray, pgVector } from "@akashic/db/sql";

test("array and vector literals bind as one text parameter", () => {
  expect(pgArray(["a", 'b"c'])).toBe('{"a","b\\"c"}');
  expect(pgVector([0.5, 0.25])).toBe("[0.5,0.25]");
  expect(parseVector("[0.5,0.25]")).toEqual([0.5, 0.25]);
  expect(containing("50%_off")).toBe("%50\\%\\_off%");
});
