import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { bool, int, loadEnv, str, url } from "@akashic/lib/config";

const Schema = v.object({
  PORT: int({ min: 1, default: 3000 }),
  DATABASE_URL: url(),
  TRUST_PROXY: bool(false),
  FGA_STORE_ID: str({ minLength: 1 }),
});

describe("loadEnv", () => {
  test("coerces strings and applies defaults", () => {
    const env = loadEnv(Schema, {
      DATABASE_URL: "postgres://localhost/x",
      FGA_STORE_ID: "s1",
      TRUST_PROXY: "true",
    });
    expect(env).toEqual({
      PORT: 3000,
      DATABASE_URL: "postgres://localhost/x",
      TRUST_PROXY: true,
      FGA_STORE_ID: "s1",
    });
  });

  test("an empty value means unset, so the default applies", () => {
    expect(
      loadEnv(Schema, { PORT: "", DATABASE_URL: "postgres://x/y", FGA_STORE_ID: "s" }).PORT,
    ).toBe(3000);
  });

  test("reports every bad key at once", () => {
    expect(() => loadEnv(Schema, { PORT: "zero", DATABASE_URL: "not a url" })).toThrow(
      /PORT[\s\S]*DATABASE_URL[\s\S]*FGA_STORE_ID|PORT[\s\S]*FGA_STORE_ID[\s\S]*DATABASE_URL/,
    );
  });

  test("a missing required key says it is required", () => {
    expect(() => loadEnv(Schema, { DATABASE_URL: "postgres://x/y" })).toThrow(
      /FGA_STORE_ID: is required/,
    );
  });
});
