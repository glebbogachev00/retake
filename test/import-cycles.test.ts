/** No module imports itself back at run time. Two such loops (record ↔
    render, flags ↔ verify) worked only because ESM resolves functions at
    call time; they tied the biggest modules together and made each harder to
    read alone. Type-only imports vanish at build and are allowed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : []);
}

test("no runtime import cycles in src/", () => {
  const graph = new Map<string, string[]>();
  for (const f of sources("src")) {
    const deps: string[] = [];
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (/^\s*(import|export)\s+type\b/.test(line)) continue;
      for (const m of line.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
        const p = path.normalize(path.join(path.dirname(f), m[1])).replace(/\.js$/, ".ts");
        if (fs.existsSync(p)) deps.push(p);
      }
    }
    graph.set(f, deps);
  }
  const loops = new Set<string>();
  const walk = (n: string, stack: string[]) => {
    for (const d of graph.get(n) ?? []) {
      if (stack.includes(d)) loops.add([...stack.slice(stack.indexOf(d)), d].map((x) => path.basename(x)).join(" → "));
      else if (stack.length < 12) walk(d, [...stack, d]);
    }
  };
  for (const f of graph.keys()) walk(f, [f]);
  assert.deepEqual([...loops], [], "modules that import each other at run time");
});
