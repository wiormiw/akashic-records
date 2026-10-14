import { beforeEach, describe, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok } from "@akashic/lib/result";
import { currentTraceparent, traced, withConsumerSpan } from "@akashic/lib/tracing";
import { recordSpans } from "@akashic/lib/testing";

const recorder = recordSpans();
beforeEach(() => recorder.reset());

describe("traced", () => {
  test("ends the span with its attributes on success", async () => {
    expect(await traced("authz.check", { "akashic.realm.id": "r1" }, async () => 7)).toBe(7);
    const [span] = recorder.spans();
    expect(span?.name).toBe("authz.check");
    expect(span?.attributes["akashic.realm.id"]).toBe("r1");
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  test("a returned err marks the span with its code, without throwing", async () => {
    const result = await traced("realm.approve", {}, async () =>
      err(fail.conflict(ErrorCode.realm.duplicateSlug, "Taken.")),
    );
    expect(result.ok).toBe(false);
    const [span] = recorder.spans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["akashic.error.code"]).toBe("realm.duplicate_slug");
  });

  test("a throw is recorded and rethrown", async () => {
    await expect(
      traced("mail.send", {}, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
    expect(recorder.spans()[0]?.events[0]?.name).toBe("exception");
  });

  test("an abort is cancelled, not an error", async () => {
    const reason = new DOMException("stop", "AbortError");
    await expect(
      traced("authz.check", {}, async () => {
        throw reason;
      }),
    ).rejects.toBe(reason);
    const [span] = recorder.spans();
    expect(span?.attributes["akashic.cancelled"]).toBe(true);
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  test("an ok value passes through untouched", async () => {
    expect(await traced("x", {}, async () => ok(1))).toEqual(ok(1));
  });
});

describe("propagation", () => {
  test("a consumer span continues the producer's trace", async () => {
    const parent = await traced("publish", {}, async () => currentTraceparent());
    await withConsumerSpan("consume realm.member_changed", parent, async () => undefined);
    const [producer, consumer] = recorder.spans();
    expect(consumer?.spanContext().traceId).toBe(producer?.spanContext().traceId);
  });
});
