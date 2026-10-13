import { describe, expect, test } from "bun:test";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { toProblem } from "@akashic/lib/problem";

describe("problem", () => {
  test("a kind decides the status, and the code is on the body", () => {
    const { status, body } = toProblem(
      fail.conflict(ErrorCode.realm.duplicateSlug, "Taken."),
      "t1",
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "realm.duplicate_slug", detail: "Taken.", traceId: "t1" });
  });

  test("an internal error never shows its message", () => {
    const { status, body } = toProblem(
      fail.internal(ErrorCode.common.unexpected, "password=hunter2"),
      "t1",
    );
    expect(status).toBe(500);
    expect(body.detail).not.toContain("hunter2");
  });
});
