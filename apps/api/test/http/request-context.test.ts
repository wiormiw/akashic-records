import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
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
    .get("/livez", (c) => c.text("ok"));
  app.onError(problemHandler(silentLogger()));
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
