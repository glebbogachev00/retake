/** verify: the reading of answers, and the rule that an unanswered question fails. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { questions, stillFor, verify, __test_readAnswer } from "../src/verify.js";
import type { Manifest } from "../src/manifest.js";

const base = { name: "t", url: "http://x", steps: [] } as unknown as Manifest;

test("an echoed prompt template is not mistaken for an answer", () => {
  // Exactly what a CLI that repeats its input produces: the example shape
  // (which matches the pattern and is not JSON) followed by the real answer.
  const out = `{"ok": true|false, "why": "<one short sentence>"}\nthinking…\n{"ok":false,"why":"the button is cut off"}`;
  assert.deepEqual(__test_readAnswer(out), { ok: false, why: "the button is cut off" });
});

test("no JSON at all is not a pass", () => {
  assert.equal(__test_readAnswer("Looks fine to me!")?.ok, null);
});

test("questions pair each expect with its own scene's end still", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  fs.mkdirSync(path.join(dir, "stills"));
  for (const f of ["01-say.png", "01-say-end.png", "02-landed.png", "02-landed-end.png"]) fs.writeFileSync(path.join(dir, "stills", f), "");
  const m = { ...base, steps: [
    { action: "scene", label: "say", expect: "a text box" },
    { action: "scene", label: "landed", expect: ["one", "two"] },
  ] } as unknown as Manifest;
  const qs = questions(m, dir);
  assert.equal(qs.length, 3);
  assert.ok(qs[0].still?.endsWith("01-say-end.png"));
  assert.ok(qs[2].still?.endsWith("02-landed-end.png"));
  assert.equal(stillFor(dir, "nope", 9), null);
});

test("a manifest with no expect verifies vacuously and says how to add one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  const v = verify({ ...base, steps: [{ action: "scene", label: "a" }] } as unknown as Manifest, dir);
  assert.equal(v.ok, true);
  assert.match(v.lines.join("\n"), /expect/);
});

test("expectations with no take.json FAIL — a check that could not run did not pass", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  const m = { ...base, steps: [{ action: "scene", label: "a", expect: "something" }] } as unknown as Manifest;
  const v = verify(m, dir);
  assert.equal(v.ok, false);
});
