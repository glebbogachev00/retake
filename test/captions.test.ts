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
