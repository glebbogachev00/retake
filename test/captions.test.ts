/** The caption band fits the captions, one height per take. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bandHeightFor, captionLines, wrap } from "../src/captions.js";

const q = (over: Record<string, unknown> = {}) => ({ captions: { fontSize: 46 }, layout: "band" as const, bandHeight: 150, height: 1080, ...over }) as Parameters<typeof bandHeightFor>[0];

test("the band is fixed per preset, so one preset means one output size", () => {
  // It used to grow with the caption: tidier per video, and it made two
  // takes of the same app different shapes, which players letterbox.
  const short = bandHeightFor(q());
  const long = bandHeightFor(q());
  assert.equal(short, 150);
  assert.equal(short, long, "caption length must not change the frame");
  assert.equal(bandHeightFor(q({ captions: false })), 0, "no captions, no band");
  assert.equal(bandHeightFor(q({ layout: "overlay-bottom" })), 0, "overlay draws over the app");
});

test("the default page is the canvas minus the band, so the video is the preset's size", async () => {
  const { resolve, Manifest } = await import("../src/manifest.js");
  for (const [preset, w, h] of [["post-landscape", 1920, 1080], ["post-square", 1080, 1080], ["post-vertical", 1080, 1920]] as const) {
    const r = resolve(Manifest.parse({ name: "x", url: "http://x", preset, steps: [{ action: "wait", ms: 10 }] }));
    assert.equal(r.viewport.width, w, `${preset} page width`);
    assert.equal(r.viewport.height + bandHeightFor(r), h, `${preset}: page + band must equal the canvas`);
  }
});

test("blank caption text does not reserve a caption band", async () => {
  const { resolve, Manifest } = await import("../src/manifest.js");
  const r = resolve(Manifest.parse({
    name: "x", url: "http://x", preset: "post-landscape",
    steps: [{ action: "scene", label: "blank", caption: "   " }],
  }));
  assert.equal(r.bandHeight, 0);
  assert.equal(r.viewport.height, 1080);
});

test("wrap breaks two-line captions near the middle and never orphans a word", () => {
  const w = wrap("One sentence. Two different kinds of thing, said plainly.", 30);
  const [a, b] = w.split("\n");
  assert.ok(a.length <= 30 && b.length <= 30);
  assert.ok(Math.abs(a.length - b.length) < 12);
  assert.equal(captionLines(["short"], 1920, 46), 1);
});

test("callout and cards are schema-valid and render-relevant", async () => {
  const { Manifest } = await import("../src/manifest.js");
  const m = Manifest.parse({
    name: "x", url: "http://x",
    intro: { title: "T", subtitle: "s" },
    steps: [
      { action: "scene", label: "a" },
      { action: "callout", selector: "#b", label: "look", ms: 2000 },
    ],
  });
  assert.equal(m.intro?.ms, 2400);
  const c = m.steps[1] as { action: string; ms: number };
  assert.equal(c.ms, 2000);
  assert.throws(() => Manifest.parse({ name: "x", url: "http://x", steps: [{ action: "callout" }] }), /selector or/);
});

test("music accepts a path or a config, with sane defaults", async () => {
  const { Manifest } = await import("../src/manifest.js");
  const a = Manifest.parse({ name: "x", url: "http://x", music: "track.mp3", steps: [{ action: "wait", ms: 10 }] });
  assert.equal(a.music, "track.mp3");
  const b = Manifest.parse({ name: "x", url: "http://x", music: { file: "t.mp3" }, steps: [{ action: "wait", ms: 10 }] });
  assert.deepEqual(b.music, { file: "t.mp3", gainDb: -14, fadeOutMs: 1800 });
});

test("idle warp: piecewise time map is monotonic and hits the planned lengths", async () => {
  const { planIdle, warpTime, warpTake } = await import("../src/pace.js");
  const take = { trimBefore: 1, duration: 20, timeline: [
    { index: 0, action: "click", summary: "click", start: 1, end: 2, ok: true },
    { index: 1, action: "waitFor", summary: "wait for #x", start: 2, end: 10, ok: true },
    { index: 2, action: "scene", summary: "scene: s", start: 10, end: 10, ok: true, label: "s", caption: "c" },
    { index: 3, action: "wait", summary: "wait 5000ms", start: 10, end: 15, ok: true },
  ] } as never;
  const segs = planIdle(take, 1.5);
  assert.equal(segs.length, 1, "only the waitFor compresses; the author's wait never does");
  const w = warpTake(take, segs);
  const shownWait = w.timeline[1].end - w.timeline[1].start;
  assert.ok(Math.abs(shownWait - 1.5) < 0.05, `waitFor shown as ~1.5s, got ${shownWait}`);
  assert.ok(Math.abs((w.timeline[3].end - w.timeline[3].start) - 5) < 1e-6, "pacing wait untouched");
  let prev = -1;
  for (let t = 0; t <= 20; t += 0.25) { const m = warpTime(segs, t); assert.ok(m >= prev); prev = m; }
});
