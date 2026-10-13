import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { silentLogger } from "@akashic/lib/log";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import { parseOrigins, security } from "@/http/security.ts";

const site = "http://site.test";

const app = (allowedOrigins: string[] = [site]) => {
  const server = new Hono<AppEnv>()
    .use(security({ allowedOrigins, maxBodyBytes: 64, largeBodyPaths: ["/uploads"] }))
    .get("/read", (c) => c.text("ok"))
    .post("/write", (c) => c.text("ok"))
    .post("/uploads/x", (c) => c.text("ok"));
  server.onError(problemHandler(silentLogger()));
  return server;
};

const send = async (
  server: ReturnType<typeof app>,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) => {
  const response = await server.request(`http://api.test${path}`, { method, headers });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    code: text.startsWith("{") ? (JSON.parse(text) as { code: string }).code : text,
  };
};

describe("security", () => {
  test("every response carries the hardening headers", async () => {
    const { headers } = await send(app(), "GET", "/read");
    expect(headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("refuses an oversized body by its declared length, except on upload paths", async () => {
    const big = { "content-length": "65" };
    expect((await send(app(), "POST", "/write", big)).code).toBe(
      "common.request.payload_too_large",
    );
    expect((await send(app(), "POST", "/uploads/x", big)).status).toBe(200);
    expect((await send(app(), "POST", "/write", { "content-length": "64" })).status).toBe(200);
  });

  test("a state-changing request from a foreign page is refused; ours and non-browser ones pass", async () => {
    const server = app();
    expect((await send(server, "POST", "/write", { origin: "http://evil.test" })).status).toBe(403);
    expect((await send(server, "POST", "/write", { origin: site })).status).toBe(200);
    expect((await send(server, "POST", "/write")).status).toBe(200);
    expect((await send(server, "GET", "/read", { origin: "http://evil.test" })).status).toBe(200);
  });

  test("with no origins configured, no browser origin is trusted and none is checked", async () => {
    const { status, headers } = await send(app([]), "POST", "/write", {
      origin: "http://evil.test",
    });
    expect(status).toBe(200);
    expect(headers.get("access-control-allow-origin")).toBeNull();
  });

  test("CORS reflects an allowed origin with credentials, and no other", async () => {
    const ours = await send(app(), "GET", "/read", { origin: site });
    expect(ours.headers.get("access-control-allow-origin")).toBe(site);
    expect(ours.headers.get("access-control-allow-credentials")).toBe("true");
    const foreign = await send(app(), "GET", "/read", { origin: "http://evil.test" });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("parseOrigins splits on commas and drops blanks", () => {
    expect(parseOrigins(" http://a.test , ,http://b.test")).toEqual([
      "http://a.test",
      "http://b.test",
    ]);
    expect(parseOrigins("")).toEqual([]);
  });
});
