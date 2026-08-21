/** Limits that only show up past the two-minute mark — from the 171-step report. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Manifest, warnings } from "../src/manifest.js";
import { capSecondsFor, cursorMoves, CURSOR_MOVE_LIMIT } from "../src/record.js";

const base = { name: "t", url: "http://localhost:3000" };
const click = (n: number) => Array.from({ length: n }, (_, i) => ({ action: "click", selector: `#b${i}` }));

test("duplicate scene labels are refused at the schema", () => {
  const r = Manifest.safeParse({ ...base, steps: [{ action: "scene", label: "ask" }, { action: "wait", ms: 100 }, { action: "scene", label: "ask" }] });
  assert.equal(r.success, false);
  const msg = r.error!.issues.map((i) => i.message).join(" | ");
  assert.match(msg, /duplicate scene label/);
  assert.match(msg, /also step 0/);
});

test("too many cursor moves warns (the overlay cannot survive it)", () => {
  const m = Manifest.parse({ ...base, steps: [{ action: "scene", label: "a" }, ...click(CURSOR_MOVE_LIMIT + 5)] });
  assert.equal(cursorMoves(m), CURSOR_MOVE_LIMIT + 5);
  assert.ok(warnings(m).some((w) => /cursor moves/.test(w) && /MISSING/.test(w)));
  const quiet = Manifest.parse({ ...base, cursor: false, steps: [{ action: "scene", label: "a" }, ...click(CURSOR_MOVE_LIMIT + 5)] });
  assert.ok(!warnings(quiet).some((w) => /cursor moves/.test(w)), "cursor: false is the honest opt-out");
});

test("a scene with only waits in it is flagged", () => {
  const m = Manifest.parse({ ...base, steps: [{ action: "scene", label: "empty" }, { action: "wait", ms: 900 }, { action: "scene", label: "real" }, { action: "click", selector: "#x" }] });
  const w = warnings(m);
  assert.ok(w.some((x) => /scene "empty" has only waits/.test(x)));
  assert.ok(!w.some((x) => /scene "real"/.test(x)));
});

test("one cap for recorder and check: explicit wins, else it scales with the demo", () => {
  const short = Manifest.parse({ ...base, steps: [{ action: "scene", label: "a" }, { action: "wait", ms: 1000 }] });
  assert.equal(capSecondsFor(short), 240, "never under 240s");
  const long = Manifest.parse({ ...base, steps: [{ action: "scene", label: "a" }, ...click(170)] });
  assert.equal(capSecondsFor(long), 171 * 10, "≈10s per step");
  const set = Manifest.parse({ ...base, maxSeconds: 900, steps: [{ action: "scene", label: "a" }] });
  assert.equal(capSecondsFor(set), 900, "the author's number wins");
});
