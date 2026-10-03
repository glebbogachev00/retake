/** Record like the good ones: a reference fills in what a manifest left
    unset, never overrides what it said, and judges a take by what the
    examples actually did. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadManifest, parseManifest, type Manifest } from "../src/manifest.js";
import { applyReference, compareTake, learn, measure, planNotes, readExample, readReference, writeReference, type Example } from "../src/reference.js";
import type { Take, TimelineEntry } from "../src/record.js";

const BASELINE = parseManifest({ name: "baseline", url: "http://localhost/", steps: [{ action: "wait" }] }, "(baseline)") as Record<string, unknown>;

function manifest(over: Record<string, unknown> = {}): Manifest {
  return parseManifest({
    name: "good",
    url: "http://localhost:3000",
    preset: "post-vertical",
    scale: 2,
    reducedMotion: true,
    steps: [
      { action: "scene", label: "open", caption: "An empty board." },
      { action: "wait", ms: 1000 },
      { action: "click", selector: "#go" },
      { action: "scene", label: "result", caption: "It is filed." },
      { action: "wait", ms: 2000 },
    ],
    ...over,
  }, "test");
}

/** A take: trimmed head of 1s, scenes at the given seconds of finished video. */
function take(open: number, firstAction: number, result: number, end: number): Take {
  const t0 = 1;
  const e = (index: number, action: TimelineEntry["action"], start: number, endAt: number, label?: string): TimelineEntry =>
    ({ index, action, summary: action, start: t0 + start, end: t0 + endAt, ok: true, ...(label ? { label } : {}) });
  return {
    screenshots: [],
    timeline: [
      e(0, "scene", open, open, "open"),
      e(1, "wait", open, firstAction),
      e(2, "click", firstAction, firstAction + 0.3),
      e(3, "scene", result, result, "result"),
      e(4, "wait", result, end),
    ],
    duration: t0 + end,
    trimBefore: t0,
    startedAt: "", finishedAt: "",
    ok: true,
    quality: { preset: "post-vertical", width: 1080, height: 1920, scale: 2, fps: 30 },
  };
}

const ex = (name: string, t?: Take, over: Record<string, unknown> = {}): Example => ({ name, from: `/x/${name}`, manifest: manifest({ name, ...over }), take: t });

test("only settings EVERY example agrees on are carried, and baseline values are left out", () => {
  const r = learn("capture", [ex("a", take(0, 1, 1.5, 4)), ex("b", take(0, 1.2, 1.8, 4.5), { camera: "auto" })], undefined, BASELINE);
  assert.equal(r.defaults.preset, "post-vertical");
  assert.equal(r.defaults.scale, 2);
  assert.equal(r.defaults.reducedMotion, true);
  // One example zoomed, one did not: that is a choice per demo, not a house style.
  assert.equal(r.defaults.camera, undefined);
  assert.ok(r.varies.includes("camera"));
  // Agreed, but it is what Retake does anyway — carrying it buries the real choices.
  assert.equal(r.defaults.keepInTab, undefined);
  assert.equal(r.defaults.colorScheme, undefined);
});

test("a demo is never upgraded to a launch, and a reference never carries content", () => {
  const r = learn("launchy", [ex("a", undefined, { mode: "launch", intro: { title: "Hi" }, viewport: { width: 800, height: 600 } })], undefined, BASELINE);
  for (const k of ["mode", "intro", "viewport", "url", "steps", "title"]) assert.equal((r.defaults as Record<string, unknown>)[k], undefined, k);
  // And a hand-edited reference cannot smuggle them in either.
  const out = applyReference({ name: "x", url: "http://a/", steps: [] }, { defaults: { mode: "launch", url: "http://evil/", preset: "draft" } as never });
  assert.equal(out.mode, undefined);
  assert.equal(out.url, "http://a/");
  assert.equal(out.preset, "draft");
});

test("the manifest's own values always win; objects merge one level", () => {
  const out = applyReference({ preset: "post-square", theme: { ink: "#000" } }, { defaults: { preset: "post-vertical", scale: 2, theme: { background: "#fff", ink: "#333" } } as never });
  assert.equal(out.preset, "post-square");
  assert.equal(out.scale, 2);
  assert.deepEqual(out.theme, { background: "#fff", ink: "#000" });
});

test("pacing is measured from the take, in seconds of finished video", () => {
  const m = measure(take(0, 1, 1.5, 4), manifest());
  assert.equal(m.seconds, 4);
  assert.deepEqual(m.shots.map((s) => [s.label, s.seconds]), [["open", 1.5], ["result", 2.5]]);
  assert.equal(m.openingHold, 1);
  assert.equal(m.endingHold, 2.7);
  // tempo is applied at render, so the viewer sees it faster
  assert.equal(measure(take(0, 1, 1.5, 4), manifest({ tempo: 2 })).seconds, 2);
});

test("a take inside the examples' range passes; a slow one is told where", () => {
  const r = learn("capture", [ex("a", take(0, 1, 1.5, 4)), ex("b", take(0, 1.2, 1.8, 4.5))], undefined, BASELINE);
  const fine = compareTake(take(0, 1.1, 1.6, 4.2), manifest(), r);
  assert.ok(fine.every((v) => v.ok), fine.filter((v) => !v.ok).map((v) => v.line).join("; "));
  // Nothing happens for 8.9s, then the result flashes past and the video ends.
  const slow = compareTake(take(0, 8.9, 9, 9.3), manifest(), r).filter((v) => !v.ok).map((v) => v.line).join("\n");
  assert.match(slow, /scene "open" holds 9\.0s/);
  assert.match(slow, /first action at 8\.9s/);
  assert.match(slow, /scene "result" is on screen 0\.3s — too short to read/);
  assert.match(slow, /result held 0\.1s/);
});

test("before the camera: wordy captions and overrides are named", () => {
  const r = learn("capture", [ex("a", take(0, 1, 1.5, 4))], undefined, BASELINE);
  const notes = planNotes(manifest({ preset: "draft", steps: [{ action: "scene", label: "s", caption: "one two three four five six seven eight nine ten eleven" }, { action: "wait" }] }), r).join("\n");
  assert.match(notes, /caption is 11 words/);
  assert.match(notes, /preset: "draft" overrides "capture"'s "post-vertical"/);
});

test("learn refuses a take that failed, ran brisk, or is a fragment", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ref-"));
  const out = path.join(ws, "outputs", "bad");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.used.yaml"), YAML.stringify(manifest({ name: "bad" })));
  for (const [patch, why] of [[{ ok: false }, /failed steps/], [{ brisk: true }, /brisk/], [{ partial: "(until) open" }, /partial/]] as const) {
    fs.writeFileSync(path.join(out, "take.json"), JSON.stringify({ ...take(0, 1, 1.5, 4), ...patch }));
    assert.throws(() => readExample(out, parseManifest), why);
  }
});

test("end to end: learn from an outputs folder, then `like:` fills in a new manifest", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ref-"));
  const out = path.join(ws, "outputs", "good");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "manifest.used.yaml"), YAML.stringify(manifest()));
  fs.writeFileSync(path.join(out, "take.json"), JSON.stringify(take(0, 1, 1.5, 4)));
  const r = learn("capture", [readExample(out, parseManifest)], "the Capture launch clips", BASELINE);
  const file = writeReference(path.join(ws, "references"), r);
  // Paths are stored relative to the reference, so the workspace can move.
  const back = readReference(file);
  assert.equal(back.examples[0].from, path.join("..", "outputs", "good"));
  assert.equal(back.about, "the Capture launch clips");

  fs.mkdirSync(path.join(ws, "demos"));
  const demo = path.join(ws, "demos", "next.yaml");
  fs.writeFileSync(demo, "name: next\nlike: capture\nurl: http://localhost:3000\npreset: post-square\nsteps:\n  - { action: wait }\n");
  const l = loadManifest(demo);
  assert.equal(l.manifest.preset, "post-square"); // said → kept
  assert.equal(l.manifest.scale, 2);               // not said → from the reference
  assert.equal(l.manifest.reducedMotion, true);
  assert.equal(l.reference?.ref.name, "capture");
});

test("`like:` naming a reference that does not exist says how to make one", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ref-"));
  fs.mkdirSync(path.join(ws, "demos"));
  const demo = path.join(ws, "demos", "x.yaml");
  fs.writeFileSync(demo, "name: x\nlike: nowhere\nurl: http://localhost:3000\nsteps:\n  - { action: wait }\n");
  assert.throws(() => loadManifest(demo), /retake learn nowhere outputs\//);
});
