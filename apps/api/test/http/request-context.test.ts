import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { silentLogger } from "@akashic/lib/log";
import { createLifecycle } from "@akashic/lib/lifecycle";
import { captureLogger, recordSpans } from "@akashic/lib/testing";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import { REQUEST_ID_HEADER, requestContext } from "@/http/request-context.ts";

const recorder = recordSpans();
beforeEach(() => recorder.reset());

const build = (budgetMs = 1000, logger = silentLogger()) => {
  const app = new Hono<AppEnv>()
    .use(
      requestContext({
        budgetMs,
        logger,
        lifecycle: createLifecycle(silentLogger()),
        service: "test",
      }),
    )
    .get("/x", (c) => c.text(c.get("requestId")))
    .get("/slow", async (c) => {
      await Bun.sleep(60);
      return c.text("late");
    })
    .get("/livez", (c) => c.text("ok"))
    .get("/dup", () => {
      throw Object.assign(new Error("dup key (email)=(ann@example.test)"), { code: "23505" });
    })
    .get("/refused", () => {
      throw fail.conflict(ErrorCode.realm.duplicateSlug, "That name is taken.");
    });
  app.onError(problemHandler(logger));
  return app;
};

describe("request id", () => {
  test("echoed from the header", async () => {
    const res = await build().request("/x", { headers: { [REQUEST_ID_HEADER]: "abc" } });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("abc");
    expect(await res.text()).toBe("abc");
  });

  test("generated when absent", async () => {
    const res = await build().request("/x");
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy();
  });
});

describe("deadline", () => {
  test("a handler that outlasts its budget becomes a 502 timeout", async () => {
    const res = await build(10).request("/slow");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("common.request.timeout");
  });
});

describe("spans", () => {
  test("a server span for /x, none for /livez", async () => {
    const app = build();
    await app.request("/x");
    await app.request("/livez");
    const names = recorder.spans().map((s) => s.name);
    expect(names.some((n) => n.includes("/x"))).toBe(true);
    expect(names.some((n) => n.includes("/livez"))).toBe(false);
  });
});

/** What a span carries out of the process. The span object itself is cyclic. */
const exported = (span: ReturnType<typeof recorder.spans>[number] | undefined) =>
  JSON.stringify({ attributes: span?.attributes, events: span?.events, status: span?.status });

const serverSpan = (path: string) => recorder.spans().find((s) => s.name.includes(path));

describe("server span url", () => {
  test("keeps the origin and path, never the query", async () => {
    await build().request("/x?ticket=secret&q=a@b.c");
    const span = serverSpan("/x");
    expect(span).toBeDefined();
    expect(span?.attributes["url.full"]).toBe("http://localhost/x");
    const all = exported(span) + span?.name;
    for (const leak of ["ticket=", "secret", "a@b.c"]) expect(all).not.toContain(leak);
  });
});

describe("server span errors", () => {
  test("an unexpected error's message and stack stay out of the server span", async () => {
    const { logger, lines } = captureLogger();
    const res = await build(1000, logger).request("/dup");
    // The response and its log line are what they were.
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe(ErrorCode.common.unexpected);
    expect(JSON.stringify(lines.find((l) => l.msg === "unhandled error"))).toContain(
      "ann@example.test",
    );

    const span = serverSpan("/dup");
    expect(span).toBeDefined();
    expect(exported(span)).not.toContain("ann@example.test");
    expect(exported(span)).not.toContain("at ");
    expect(span?.attributes["error.type"]).toBe("23505");
    expect(span?.events.filter((e) => e.name === "exception")).toHaveLength(1);
  });

  test("an AppError keeps its client-facing message on the server span", async () => {
    const res = await build().request("/refused");
    expect(res.status).toBe(409);
    const span = serverSpan("/refused");
    expect(span?.attributes["error.type"]).toBe(ErrorCode.realm.duplicateSlug);
    expect(span?.events[0]?.attributes?.["exception.message"]).toBe("That name is taken.");
  });
});

describe("access log", () => {
  test("one line per response with its status", async () => {
    const { logger, lines } = captureLogger();
    await build(1000, logger).request("/x");
    expect(lines.find((l) => l.msg === "request")?.status).toBe(200);
  });

  test("a request past its budget is logged too, with the 502 it was answered with", async () => {
    const { logger, lines } = captureLogger();
    await build(10, logger).request("/slow");
    const line = lines.find((l) => l.msg === "request");
    expect(line?.status).toBe(502);
    expect(typeof line?.ms).toBe("number");
  });
});
