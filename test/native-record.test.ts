/** App demos, sprint 4: the take. The real recording is checked by hand on
    a Mac (TextEdit: check passes, one window, a drawn arrow); these pin the
    pieces that decide what the video shows. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cursorPath } from "../src/drivers/native-record.js";
import { isRawTake, NATIVE_TAKE } from "../src/paths.js";
import { keepPrevious, keptTakes, stashPrevious } from "../src/record.js";

/** Evaluate one of ffmpeg's overlay expressions at time t, in JS. */
function at(expr: string, t: number): number {
  const js = expr.replace(/\bt\b/g, String(t));
  const gte = (x: number, a: number) => (x >= a ? 1 : 0);
  const lt = (x: number, a: number) => (x < a ? 1 : 0);
  const clip = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
  return new Function("gte", "lt", "clip", "pow", `return ${js}`)(gte, lt, clip, Math.pow) as number;
}

test("the arrow rests, then glides onto each click and arrives as it lands", () => {
  const p = cursorPath([{ t: 2, x: 400, y: 300 }, { t: 5, x: 1000, y: 700 }], { x: 960, y: 540 });
  const pos = (t: number) => [Math.round(at(p.x, t) + 4), Math.round(at(p.y, t) + 4)];
  assert.equal(p.from, 1.4, "it appears for the glide into the first click");
  assert.deepEqual(pos(1.4), [960, 540], "starting from the middle of the window");
  assert.deepEqual(pos(2), [400, 300], "on the first click as it lands");
  assert.deepEqual(pos(3.5), [400, 300], "resting there");
  assert.deepEqual(pos(5), [1000, 700], "on the second click as it lands");
  assert.deepEqual(pos(9), [1000, 700], "and resting after");
  const mid = pos(4.7);
  assert.ok(mid[0] > 400 && mid[0] < 1000, "gliding in between");
  assert.ok(!/if\(/.test(p.x), "flat, not nested: ffmpeg stops at 98 nesting levels");
  const many = cursorPath(Array.from({ length: 200 }, (_, i) => ({ t: i, x: i, y: i })), { x: 0, y: 0 });
  assert.equal(Math.round(at(many.x, 150) + 4), 150);
});

test("kept and restored takes recognise an app recording as the raw take", () => {
  assert.ok(isRawTake(NATIVE_TAKE));
  assert.ok(isRawTake("abc.webm"));
  assert.ok(!isRawTake("demo.mp4"), "the rendered video is not the raw take");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-keep-"));
  fs.writeFileSync(path.join(dir, NATIVE_TAKE), "video");
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({ ok: true, video: path.join(dir, NATIVE_TAKE), timeline: [{ action: "click" }], duration: 3 }));
  stashPrevious(dir);
  keepPrevious(dir, () => {});
  const kept = keptTakes(dir);
  assert.equal(kept.length, 1, "the app take was kept as a version");
});
