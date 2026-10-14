import { beforeEach, describe, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok } from "@akashic/lib/result";
import { currentTraceparent, traced, withConsumerSpan } from "@akashic/lib/tracing";
import { recordSpans } from "@akashic/lib/testing";

const recorder = recordSpans();

/** What a span carries out of the process. The span object itself is cyclic. */
const exported = (span: ReturnType<typeof recorder.spans>[number] | undefined) =>
  JSON.stringify({ attributes: span?.attributes, events: span?.events, status: span?.status });
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

  test("a TimeoutError or a shutdown abort is cancelled, not an error", async () => {
    for (const reason of [
      new DOMException("late", "TimeoutError"),
      new Error("shutting down: SIGTERM"),
    ]) {
      const controller = new AbortController();
      controller.abort(reason);
      await expect(
        traced(
          "x",
          {},
          async () => {
            throw controller.signal.reason;
          },
          { signal: controller.signal },
        ),
      ).rejects.toBe(reason);
    }
    expect(recorder.spans()).toHaveLength(2);
    for (const span of recorder.spans()) {
      expect(span.attributes["akashic.cancelled"]).toBe(true);
      expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
      expect(span.events).toEqual([]);
    }
  });

  test("an unexpected error's message is not recorded, only its name and code", async () => {
    const pgError = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "user_email_key": (email)=(ann@example.test)',
      ),
      { code: "23505" },
    );
    await expect(
      traced("x", {}, async () => {
        throw pgError;
      }),
    ).rejects.toBe(pgError);
    const [span] = recorder.spans();
    expect(exported(span)).not.toContain("ann@example.test");
    expect(span?.attributes["error.type"]).toBe("23505");
    expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: "23505" });
  });

  test("an AppError keeps its message: it was written for clients", async () => {
    const failure = fail.external(ErrorCode.common.timeout, "The request took too long.");
    await expect(
      traced("x", {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const [span] = recorder.spans();
    expect(span?.events[0]?.attributes?.["exception.message"]).toBe("The request took too long.");
    expect(span?.attributes["error.type"]).toBe(ErrorCode.common.timeout);
  });

  test("a throw that is not the signal's reason is an error even once the signal aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("shutting down: SIGTERM"));
    const other = new TypeError("boom");
    await expect(
      traced(
        "x",
        {},
        async () => {
          throw other;
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(other);
    const [span] = recorder.spans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["error.type"]).toBe("TypeError");
  });

  test("an ok value passes through untouched", async () => {
    expect(await traced("x", {}, async () => ok(1))).toEqual(ok(1));
  });
});

describe("withConsumerSpan", () => {
  test("a handler stopped by its own signal is cancelled, not an error", async () => {
    const controller = new AbortController();
    const reason = new DOMException("late", "TimeoutError");
    controller.abort(reason);
    await expect(
      withConsumerSpan(
        "consume x",
        undefined,
        async () => {
          throw reason;
        },
        {},
        controller.signal,
      ),
    ).rejects.toBe(reason);
    const [span] = recorder.spans();
    expect(span?.attributes["akashic.cancelled"]).toBe(true);
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  test("a handler's error records its code, not its message", async () => {
    const failure = Object.assign(new Error("secret@example.test"), { code: "ECONNRESET" });
    await expect(
      withConsumerSpan("consume x", undefined, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const [span] = recorder.spans();
    expect(exported(span)).not.toContain("secret@example.test");
    expect(span?.attributes["error.type"]).toBe("ECONNRESET");
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
