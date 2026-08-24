/** The caption band fits the captions, one height per take. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { bandHeightFor, captionLines, wrap } from "../src/captions.js";

const q = (over: Partial<Parameters<typeof bandHeightFor>[0]> = {}) => ({ captions: { fontSize: 46 }, layout: "band" as const, bandHeight: 150, bandFit: "text" as const, height: 1080, ...over });

test("one line of caption gets a one-line band; two lines a taller one; none gets none", () => {
  const one = bandHeightFor(q(), 1920, ["Short."]);
  const two = bandHeightFor(q(), 1920, ["a caption long enough to wrap ".repeat(6)]);
  assert.ok(one >= 90 && one <= 110, `one line ≈ 100px, got ${one}`);
  assert.ok(two > one + 40, `two lines noticeably taller: ${two} vs ${one}`);
  assert.equal(one % 2, 0, "even, for yuv420p");
  assert.equal(bandHeightFor(q({ captions: false }), 1920, ["x"]), 0);
  assert.equal(bandHeightFor(q({ layout: "overlay-bottom" }), 1920, ["x"]), 0);
});

test("fixed-canvas presets fill to the canvas whatever the page height was", () => {
  const sq = q({ bandFit: "fill", bandHeight: 120, height: 960, captions: { fontSize: 36 } });
  assert.equal(bandHeightFor(sq, 1080, ["x"]), 120);          // new take: page 960
  assert.equal(bandHeightFor(sq, 1080, ["x"], 950), 130);     // older take: page 950 → still 1080
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
