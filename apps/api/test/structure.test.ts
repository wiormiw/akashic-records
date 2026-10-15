import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { posix } from "node:path";

const api = `${import.meta.dir}/..`;
const repo = `${api}/../..`;
const self = "apps/api/test/structure.test.ts";

/**
 * Repo-relative paths of every .ts file under the given repo-relative globs. Each glob must find
 * at least one file: a rule over nothing passes whatever the code does, so a broken glob fails.
 */
const scan = (...patterns: string[]) => {
  const out = new Set<string>();
  for (const p of patterns) {
    let found = 0;
    for (const f of new Glob(p).scanSync({ cwd: repo })) {
      const rel = f.replaceAll("\\", "/");
      if (!rel.includes("node_modules/") && rel !== self) {
        out.add(rel);
        found++;
      }
    }
    expect(found, `"${p}" matched no files`).toBeGreaterThan(0);
  }
  return [...out].sort();
};
const read = (f: string) => Bun.file(`${repo}/${f}`).text();

const everywhere = () =>
  scan("apps/api/src/**/*.ts", "apps/api/scripts/**/*.ts", "apps/api/test/**/*.ts");

// Static `from`, side-effect `import "x"` and dynamic `import("x")`, either quote style.
const specifiers = (src: string) =>
  [...src.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

const importers = async (pattern: RegExp) => {
  const found: string[] = [];
  for (const f of everywhere()) {
    if (specifiers(await read(f)).some((s) => pattern.test(s))) found.push(f);
  }
  return found;
};

describe("structure", () => {
  test("a glob that matches nothing fails the rule instead of passing it", () => {
    expect(() => scan("apps/api/src/no-such-dir/**/*.ts")).toThrow("matched no files");
    expect(scan("apps/api/src/*.ts").length).toBeGreaterThan(0);
  });

  test("only container.ts imports InferDI's container", async () => {
    expect(await importers(/^@inferdi\/inferdi(\/|$)/)).toEqual(["apps/api/src/container.ts"]);
  });

  // A module is a directory under modules/. Beside them sit module.ts, the contract every module
  // may import, and index.ts, the one file that knows every module: index.ts imports modules,
  // never the reverse.
  test("modules never import each other, nor the module list", async () => {
    const crossing: string[] = [];
    const moduleFiles = scan("apps/api/src/modules/*/**/*.ts", "apps/api/test/modules/*/**/*.ts");
    for (const f of moduleFiles) {
      const own = /^apps\/api\/(?:src|test)\/modules\/([^/]+)\//.exec(f)?.[1];
      const dir = posix.dirname(f);
      for (const s of specifiers(await read(f))) {
        const target = s.startsWith("@/")
          ? `apps/api/src/${s.slice(2)}`
          : s.startsWith(".")
            ? posix.join(dir, s)
            : undefined;
        const under = target && /^apps\/api\/(?:src|test)\/modules(?:\/(.*))?$/.exec(target);
        if (!under) continue;
        // A bare `modules` path is a directory import, which resolves to index.ts.
        const rel = under[1] || "index.ts";
        if (rel === "module.ts" || rel === "module") continue;
        const name = rel.split("/")[0];
        if (name !== own) crossing.push(`${f} -> ${rel}`);
      }
    }
    expect(crossing).toEqual([]);
  });

  // Test support is shared scaffolding: the app may not depend on it, and it may not reach into
  // a module's internals (module.ts is the contract every module may import).
  test("src never imports test code", async () => {
    const importing: string[] = [];
    for (const f of scan("apps/api/src/**/*.ts")) {
      const dir = posix.dirname(f);
      for (const s of specifiers(await read(f))) {
        const target = s.startsWith("@/")
          ? `apps/api/src/${s.slice(2)}`
          : s.startsWith(".")
            ? posix.join(dir, s)
            : s;
        if (/^apps\/api\/test(\/|$)/.test(target) || /^@\/?test(\/|$)/.test(s)) {
          importing.push(`${f} -> ${s}`);
        }
      }
    }
    expect(importing).toEqual([]);
  });

  test("test/support never imports a module's internals", async () => {
    const reaching: string[] = [];
    for (const f of scan("apps/api/test/support/**/*.ts")) {
      const dir = posix.dirname(f);
      for (const s of specifiers(await read(f))) {
        const target = s.startsWith("@/")
          ? `apps/api/src/${s.slice(2)}`
          : s.startsWith(".")
            ? posix.join(dir, s)
            : undefined;
        const under = target && /^apps\/api\/(?:src|test)\/modules(?:\/(.*))?$/.exec(target);
        if (!under) continue;
        const rel = under[1] || "index.ts";
        if (rel !== "module.ts" && rel !== "module") reaching.push(`${f} -> ${rel}`);
      }
    }
    expect(reaching).toEqual([]);
  });

  test("module code replies through a view, never a raw response", async () => {
    const raw: string[] = [];
    for (const f of scan("apps/api/src/modules/**/*.ts")) {
      if (/\b\w+\.json\(|\.body\(|new Response\(|Response\.json\(/.test(await read(f))) raw.push(f);
    }
    expect(raw).toEqual([]);
  });

  // A module folder holds role files only (spec, "Inside a module"): <m>.module.ts, <m>.service.ts
  // or <m>.<area>.service.ts, <m>.routes.ts, <m>.consumer.ts, <m>.types.ts, and the future
  // transports <m>.grpc.ts and <m>.graphql.ts. No queries, rules or helper files.
  test("a module folder holds role files only", () => {
    const stray: string[] = [];
    for (const f of scan("apps/api/src/modules/*/*.ts")) {
      const [, name, file] = /^apps\/api\/src\/modules\/([^/]+)\/(.+)$/.exec(f)!;
      const role = new RegExp(
        `^${name}(\\.[a-z][a-z0-9-]*\\.service|\\.(module|service|routes|consumer|types|grpc|graphql))\\.ts$`,
      );
      if (!role.test(file!)) stray.push(f);
    }
    expect(stray).toEqual([]);
  });

  // An exported function names the types of its parameters and result; an inline object type
  // is for a local, unexported shape. A heuristic over the source text, not the type checker:
  // it reads each `export function` / `export const x = (...) =>` parameter list (balanced
  // parentheses) and flags a parameter typed `: {` and a return annotation that opens with
  // `{`, `Promise<{`, `Result<{` and the like. It does not look inside the body, at methods of
  // a returned object, at `Promise<A | { ... }>`, or at `Record<string, { ... }>`.
  test("exported functions use named types, not inline object types", async () => {
    const inline: string[] = [];
    const files = scan("apps/api/src/modules/**/*.ts", "packages/contracts/src/**/*.ts");
    const head =
      /export\s+(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s+)?)(?:<[^>(]*>)?\(/g;
    for (const f of files) {
      const src = await read(f);
      for (const m of src.matchAll(head)) {
        let depth = 1;
        let i = m.index + m[0].length;
        const start = i;
        while (i < src.length && depth > 0) {
          const ch = src[i++];
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
        }
        const params = src.slice(start, i - 1);
        const result = src.slice(i, i + 80);
        if (/:\s*\{/.test(params) || /^\s*:\s*(?:[\w.]+<)*\{/.test(result)) {
          inline.push(`${f}: ${m[1] ?? m[2]}`);
        }
      }
    }
    expect(inline).toEqual([]);
  });

  test("nothing but main.ts starts the process", async () => {
    const starting: string[] = [];
    // lifecycle.ts defines handleSignals; main.ts is the one place that calls it.
    const files = scan(
      "apps/api/src/**/*.ts",
      "apps/api/scripts/**/*.ts",
      "packages/*/src/**/*.ts",
    );
    for (const f of files) {
      if (f === "apps/api/src/main.ts" || f === "packages/lib/src/lifecycle.ts") continue;
      if (/Bun\.serve\(|handleSignals\(/.test(await read(f))) starting.push(f);
    }
    expect(starting).toEqual([]);
  });
});
