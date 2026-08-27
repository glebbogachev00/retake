/** sense: the two halves it is built on — what a run entered, and which
    frames it is allowed to look at. Both are pure; the judgement itself is
    exercised against a real take by hand, because that is the only way to
    know whether the questions are any good. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FRAME_BUDGET, frames, sense, story } from "../src/ext/sense.js";
import type { Take } from "../src/record.js";
import type { Manifest } from "../src/manifest.js";

const take = (timeline: unknown[]): Take => ({ timeline, duration: 10, screenshots: [], startedAt: "", finishedAt: "", ok: true, trimBefore: 0, quality: { preset: "p", width: 1, height: 1, scale: 1, fps: 30 } } as unknown as Take);

test("the story is what went IN, grouped by scene — waits and scenes are not input", () => {
  const t = take([
    { action: "scene", label: "form", ok: true, summary: "scene: form" },
    { action: "wait", ok: true, summary: "wait 500ms" },
    { action: "type", ok: true, summary: 'type "SGN" → #leg-from-0' },
    { action: "waitFor", ok: true, summary: "wait for .ready" },
    { action: "click", ok: true, summary: "click button.buy" },
    { action: "scene", label: "done", ok: true, summary: "scene: done" },
    { action: "type", ok: true, summary: 'type "17400" → #price' },
  ]);
  const s = story(t);
  assert.deepEqual(s.map((x) => x.scene), ["form", "done"]);
  assert.deepEqual(s[0].did, ['type "SGN" → #leg-from-0', "click button.buy"]);
  assert.deepEqual(s[1].did, ['type "17400" → #price']);
});

test("a step that failed is marked, because a run that half-worked is the interesting one", () => {
  const s = story(take([
    { action: "scene", label: "a", ok: true },
    { action: "click", ok: false, summary: "click .buy" },
  ]));
  assert.match(s[0].did[0], /THIS STEP FAILED/);
});

test("input before the first scene is not thrown away", () => {
  const s = story(take([{ action: "type", ok: true, summary: 'type "x" → #a' }, { action: "scene", label: "a", ok: true }]));
  assert.equal(s[0].scene, "(before the first scene)");
});

function withStills(labels: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sense-"));
  fs.mkdirSync(path.join(dir, "stills"));
  labels.forEach((l, i) => fs.writeFileSync(path.join(dir, "stills", `${String(i + 1).padStart(2, "0")}-${l}-end.png`), ""));
  return dir;
}

test("a short demo gets every frame", () => {
  const labels = ["a", "b", "c"];
  const dir = withStills(labels);
  const { used, of } = frames(dir, take(labels.map((l) => ({ action: "scene", label: l, ok: true }))));
  assert.equal(of, 3);
  assert.equal(used.length, 3);
});

test("a long demo is sampled to the budget, keeps the first and the last, and reports the true total", () => {
  const labels = Array.from({ length: 37 }, (_, i) => `s${i}`);
  const dir = withStills(labels);
  const { used, of } = frames(dir, take(labels.map((l) => ({ action: "scene", label: l, ok: true }))));
  assert.equal(of, 37, "the total must be the real one, not the sampled one");
  assert.equal(used.length, FRAME_BUDGET);
  assert.equal(used[0].scene, "s0");
  assert.equal(used[used.length - 1].scene, "s36");
});

test("no stills at all is not a crash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sense-"));
  assert.deepEqual(frames(dir, take([])), { used: [], of: 0 });
});

test("nothing recorded, or nothing entered, says so and does not pretend to have checked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sense-"));
  const m = { name: "x", steps: [] } as unknown as Manifest;
  assert.match(sense(m, dir).lines[0], /no take.json/);
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify(take([{ action: "scene", label: "a", ok: true }])));
  assert.match(sense(m, dir).lines[0], /entered nothing/);
});
