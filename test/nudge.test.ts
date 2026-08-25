/**
 * Scene markers move at RENDER time. The whole point is that a caption in the
 * wrong place costs a re-render rather than a re-record, so these check the
 * two things that would make it untrustworthy: that the shift actually lands,
 * and that it can never reorder the timeline.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nudgeScenes } from "../src/render.js";
import type { Take } from "../src/record.js";

const take = (): Take => ({
  timeline: [
    { index: 0, action: "scene", summary: "scene one", start: 1, end: 1, ok: true, label: "one", caption: "A" },
    { index: 1, action: "fill", summary: "fill", start: 1, end: 4, ok: true },
    { index: 2, action: "scene", summary: "scene two", start: 5, end: 5, ok: true, label: "two", caption: "B" },
  ],
  screenshots: [], duration: 10, startedAt: "", finishedAt: "", ok: true, trimBefore: 0,
  quality: { preset: "draft", width: 960, height: 540, scale: 1, fps: 15 },
});

const m = (nudge?: number) => ({
  steps: [
    { action: "scene", label: "one" },
    { action: "scene", label: "two", ...(nudge === undefined ? {} : { nudge }) },
  ],
}) as never;

const sceneAt = (t: Take, label: string) => t.timeline.find((e) => e.label === label)!.start;

test("no nudges leaves the take untouched", () => {
  const t = take();
  const { take: out, applied } = nudgeScenes(t, m());
  assert.equal(applied.length, 0);
  assert.equal(out, t, "the same object, so nothing downstream can see a copy");
});

test("a nudge moves the marker by exactly that many milliseconds", () => {
  const { take: out, applied } = nudgeScenes(take(), m(-1500));
  assert.equal(sceneAt(out, "two"), 3.5);
  assert.equal(sceneAt(out, "one"), 1, "other scenes do not move");
  assert.deepEqual(applied, [{ label: "two", ms: -1500, clamped: false }]);
});

test("a scene's span survives the move", () => {
  const t = take();
  t.timeline[2].end = 7; // a 2s scene
  const { take: out } = nudgeScenes(t, m(1000));
  const s = out.timeline.find((e) => e.label === "two")!;
  assert.equal(s.end - s.start, 2);
});

test("a nudge can never cross the scene before it", () => {
  const { take: out, applied } = nudgeScenes(take(), m(-60_000));
  assert.ok(sceneAt(out, "two") > sceneAt(out, "one"), "order must hold");
  assert.equal(applied[0].clamped, true, "and it has to say it clamped");
});

test("a nudge past the end of the take is clamped to the take", () => {
  const { take: out, applied } = nudgeScenes(take(), m(60_000));
  assert.ok(sceneAt(out, "two") <= 10);
  assert.equal(applied[0].clamped, true);
});

test("the original take is not mutated", () => {
  const t = take();
  nudgeScenes(t, m(-1500));
  assert.equal(sceneAt(t, "two"), 5, "callers keep raw step times to compare against");
});
