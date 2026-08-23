/** The flat cursor expressions (scripts/patch-testreel.mjs) must equal
    testreel's nested originals at every instant — the patch lifts the
    ~45-move cap, it must not change a single frame. The originals are
    reconstructed here from the same strings the patch checks against. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const patchSrc = fs.readFileSync(path.join(process.cwd(), "scripts", "patch-testreel.mjs"), "utf8");
const pick = (obj: "ORIGINALS" | "FLAT", name: string): string => {
  const block = patchSrc.slice(patchSrc.indexOf(`const ${obj} = {`));
  const m = new RegExp(`\\n  ${name}: '((?:[^'\\\\]|\\\\.)*)',`).exec(block);
  if (!m) throw new Error(`no ${obj}.${name} in patch script`);
  return m[1];
};
const helper = /helper: `(.*?)`,\n/.exec(patchSrc)![1].replace("${MARK}", "");
const fn = (src: string, name: string, extra = "") => new Function(`${extra};${src};return ${name};`)() as (...a: unknown[]) => string;

// ffmpeg expression subset → JS
const ev = (expr: string, t: number, v = "t"): number => {
  const js = expr.replace(/\bif\(/g, "IF(").replace(/\blt\(/g, "LT(").replace(/\bgte\(/g, "GTE(").replace(new RegExp(`\\b${v}\\b`, "g"), "T_");
  return new Function("T_", "IF", "LT", "GTE", `return ${js}`)(t, (c: number, a: number, b: number) => (c ? a : b), (a: number, b: number) => (a < b ? 1 : 0), (a: number, b: number) => (a >= b ? 1 : 0)) as number;
};
const depth = (e: string) => { let d = 0, m = 0; for (const c of e) { if (c === "(") m = Math.max(m, ++d); else if (c === ")") d--; } return m; };

test("flat builders equal the nested originals everywhere, including overlapping transitions", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const names = ["Qe", "_t", "zt", "Mt"] as const;
  const O = Object.fromEntries(names.map((n) => [n, fn(pick("ORIGINALS", n), n)]));
  const P = Object.fromEntries(names.map((n) => [n, fn(pick("FLAT", n), n, helper)]));
  let cases = 0;
  for (let trial = 0; trial < 120; trial++) {
    const n = 1 + Math.floor(rnd() * 100); let time = 0;
    const kf: unknown[] = [], evs: unknown[] = [];
    for (let i = 0; i < n; i++) {
      time += rnd() * 1.2; // short gaps → many overlapping transitions
      kf.push({ time: +time.toFixed(3), value: Math.round(rnd() * 1000), transitionMs: rnd() < 0.15 ? 0 : Math.round(rnd() * 900) });
      evs.push({ type: rnd() < 0.5 ? "hide" : "show", time: +time.toFixed(3) });
      evs.push({ type: "move", time: +time.toFixed(3), cursorStyle: ["default", "pointer", "text"][Math.floor(rnd() * 3)] });
    }
    const fade = Math.round(rnd() * 700);
    const pairs: [string, unknown[], string][] = [["Qe", [kf, "x"], "t"], ["_t", [evs], "t"], ["zt", [evs, fade, "T"], "T"], ["Mt", [evs, "pointer", "default"], "t"]];
    for (const [name, args, v] of pairs) {
      const a = O[name](...args), b = P[name](...args);
      for (let s = 0; s < 250; s++) {
        const t = rnd() * (time + 2) - 1;
        const x = ev(a, t, v), y = ev(b, t, v); cases++;
        assert.ok(Math.abs(x - y) < 1e-6, `${name} differs at t=${t.toFixed(4)}: original ${x}, flat ${y}`);
      }
    }
  }
  assert.ok(cases > 100_000);
});

test("flat position expression stays shallow at 200 moves (ffmpeg's parser stops at 98 levels)", () => {
  const Q = fn(pick("FLAT", "Qe"), "Qe", helper);
  const kf = Array.from({ length: 200 }, (_, i) => ({ time: i * 0.4, value: i * 5, transitionMs: 300 }));
  assert.ok(depth(Q(kf, "x")) <= 3);
});

test("the installed testreel is the patched one", () => {
  let d = path.dirname(require.resolve("testreel"));
  while (!fs.existsSync(path.join(d, "package.json"))) d = path.dirname(d);
  assert.ok(fs.readFileSync(path.join(d, "dist", "index.js"), "utf8").includes("/*retake:flat-cursor*/"), "run: node scripts/patch-testreel.mjs");
});
