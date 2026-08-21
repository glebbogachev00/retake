/** Fixes from the first outside friction report — each one cost a take. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRelativeDates } from "../src/record.js";
import { loadManifest, Manifest } from "../src/manifest.js";

test("relative dates resolve to epoch ms at seed time, everything else passes through", () => {
  const now = 1_700_000_000_000;
  const out = resolveRelativeDates({ due: "-12d", fades: "+6h", at: "now", text: "-12 days", n: 3, list: ["+1w", "x"] }, now);
  assert.equal(out.due, now - 12 * 86_400_000);
  assert.equal(out.fades, now + 6 * 3_600_000);
  assert.equal(out.at, now);
  assert.equal(out.text, "-12 days", "prose that merely resembles an offset is left alone");
  assert.equal(out.n, 3);
  assert.deepEqual(out.list, [now + 7 * 86_400_000, "x"]);
});

test("a one-line script with braces gets a hint naming the YAML trap", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-yaml-"));
  const file = path.join(dir, "t.yaml");
  fs.writeFileSync(file, `name: t\nurl: http://localhost:3000\nsteps:\n  - action: evaluate\n    script: window.scrollTo({ top: 0, behavior: "instant" })\n`);
  try {
    assert.throws(() => loadManifest(file), (e: Error) => /Could not parse/.test(e.message) && /script: \|/.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("scroll accepts top/bottom as well as a selector", () => {
  const base = { name: "t", url: "http://localhost:3000" };
  for (const to of ["top", "bottom", ".row >> nth=1"]) {
    const r = Manifest.safeParse({ ...base, steps: [{ action: "scroll", to }] });
    assert.ok(r.success, `to: ${to}`);
  }
  const bad = Manifest.safeParse({ ...base, steps: [{ action: "scroll", to: "" }] });
  assert.equal(bad.success, false);
});

test("a file seed can opt into relative dates", () => {
  const r = Manifest.safeParse({ name: "t", url: "http://localhost:3000", steps: [{ action: "wait", ms: 100 }], seed: [{ kind: "file", path: "out.json", from: "in.json", relativeDates: true }] });
  assert.ok(r.success);
  assert.equal((r.data!.seed[0] as { relativeDates: boolean }).relativeDates, true);
});

test("cursor.idleHide is accepted and carried through resolve", async () => {
  const { resolve } = await import("../src/manifest.js");
  const r = Manifest.safeParse({ name: "t", url: "http://localhost:3000", steps: [{ action: "wait", ms: 100 }], cursor: { idleHide: false } });
  assert.ok(r.success);
  const q = resolve(r.data!);
  assert.notEqual(q.cursor, false);
  assert.equal((q.cursor as { idleHide?: boolean }).idleHide, false);
  const plain = resolve(Manifest.parse({ name: "t", url: "http://localhost:3000", steps: [{ action: "wait", ms: 100 }] }));
  assert.equal((plain.cursor as { idleHide?: boolean }).idleHide, undefined, "unset means: decide by length at record time");
});

test("keepInTab defaults on and can be turned off", () => {
  const base = { name: "t", url: "http://localhost:3000", steps: [{ action: "wait", ms: 100 }] };
  assert.equal(Manifest.parse(base).keepInTab, true, "a demo that opens a tab loses its subject; default protects it");
  assert.equal(Manifest.parse({ ...base, keepInTab: false }).keepInTab, false);
});
