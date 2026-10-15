import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { posix } from "node:path";

// The web app imports contracts, so contracts must never reach server code: only valibot and two
// lib subpaths that themselves import nothing.
const repo = `${import.meta.dir}/../../..`;

const scan = (pattern: string) =>
  [...new Glob(pattern).scanSync({ cwd: repo })]
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => !f.includes("node_modules/"))
    .sort();

// Static `from`, side-effect `import "x"` and dynamic `import("x")`, either quote style.
const specifiers = (src: string) =>
  [...src.matchAll(/(?:from\s+|import\s*\(?\s*)["']([^"']+)["']/g)].map((m) => m[1]!);

const allowed = new Set(["valibot", "@akashic/lib/enums", "@akashic/lib/errors"]);

describe("contracts boundary", () => {
  test("contracts import only valibot, two lib subpaths and their own files", async () => {
    const stray: string[] = [];
    for (const f of scan("packages/contracts/src/**/*.ts")) {
      const dir = posix.dirname(f);
      for (const s of specifiers(await Bun.file(`${repo}/${f}`).text())) {
        const own = s.startsWith(".") && posix.join(dir, s).startsWith("packages/contracts/src/");
        if (!own && !allowed.has(s)) stray.push(`${f} -> ${s}`);
      }
    }
    expect(stray).toEqual([]);
  });

  test("lib's enums and errors import nothing", async () => {
    const imports: string[] = [];
    for (const f of ["packages/lib/src/enums.ts", "packages/lib/src/errors.ts"]) {
      for (const s of specifiers(await Bun.file(`${repo}/${f}`).text()))
        imports.push(`${f} -> ${s}`);
    }
    expect(imports).toEqual([]);
  });

  test("a glob that matches nothing fails instead of passing vacuously", () => {
    expect(() => scan("packages/contracts/no-such-dir/**/*.ts")).toThrow("matched no files");
  });

  test("the specifier scan sees every import form", () => {
    const src = [
      `import a from "one";`,
      `import { b } from 'two';`,
      `import "three";`,
      `import 'four';`,
      `const c = await import("five");`,
      `export * from "six";`,
    ].join("\n");
    expect(specifiers(src)).toEqual(["one", "two", "three", "four", "five", "six"]);
  });
});
