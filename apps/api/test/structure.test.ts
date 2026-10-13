import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const root = `${import.meta.dir}/../src`;
const files = [...new Glob("**/*.ts").scanSync(root)].map((f) => f.replaceAll("\\", "/"));
const read = (f: string) => Bun.file(`${root}/${f}`).text();

describe("structure", () => {
  test("only container.ts imports InferDI's container", async () => {
    const importing = [];
    for (const f of files) if ((await read(f)).includes('"@inferdi/inferdi"')) importing.push(f);
    expect(importing).toEqual(["container.ts"]);
  });

  test("modules never import each other", async () => {
    const crossing: string[] = [];
    for (const f of files.filter((f) => f.startsWith("modules/"))) {
      const own = f.split("/")[1];
      for (const [, target] of (await read(f)).matchAll(/from\s+["']@\/modules\/([^/"']+)/g)) {
        if (target !== own) crossing.push(`${f} -> ${target}`);
      }
    }
    expect(crossing).toEqual([]);
  });

  test("routes reply through a view, never c.json", async () => {
    const raw: string[] = [];
    for (const f of files.filter((f) => f.endsWith(".routes.ts"))) {
      if ((await read(f)).includes("c.json(")) raw.push(f);
    }
    expect(raw).toEqual([]);
  });

  test("nothing but main.ts and scripts starts the process", async () => {
    const starting: string[] = [];
    for (const f of files.filter((f) => f !== "main.ts")) {
      if (/Bun\.serve\(|handleSignals\(/.test(await read(f))) starting.push(f);
    }
    expect(starting).toEqual([]);
  });
});
