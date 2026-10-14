import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { posix } from "node:path";

const api = `${import.meta.dir}/..`;
const repo = `${api}/../..`;
const self = "apps/api/test/structure.test.ts";

/** Repo-relative paths of every .ts file under the given repo-relative globs. */
const scan = (...patterns: string[]) => {
  const out = new Set<string>();
  for (const p of patterns) {
    for (const f of new Glob(p).scanSync({ cwd: repo })) {
      const rel = f.replaceAll("\\", "/");
      if (!rel.includes("node_modules/") && rel !== self) out.add(rel);
    }
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

  test("module code replies through a view, never a raw response", async () => {
    const raw: string[] = [];
    for (const f of scan("apps/api/src/modules/**/*.ts")) {
      if (/\b\w+\.json\(|\.body\(|new Response\(|Response\.json\(/.test(await read(f))) raw.push(f);
    }
    expect(raw).toEqual([]);
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
