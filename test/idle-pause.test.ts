/** Idle compression shortens the app's own waits, never the author's pacing.
    A click held 14.8s with `pauseAfter` while a Scratch animation played was
    cut to 1.5s, and a 20-second video came out 6 seconds long. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planIdle } from "../src/pace.js";
import type { Take } from "../src/record.js";

const take = (entries: { action: string; start: number; end: number }[]): Take =>
  ({ timeline: entries.map((e, index) => ({ index, ok: true, summary: e.action, ...e })) } as unknown as Take);

test("a click's declared pause is played at real speed", () => {
  const t = take([{ action: "click", start: 2, end: 18 }]);
  assert.equal(planIdle(t, 1.5, [14.8]).length, 0, "16s = 1.2s of click + 14.8s of pause: nothing of the app's to compress");
  assert.equal(planIdle(t, 1.5, []).length, 1, "with no declared pause, a 16s click is the app being slow");
});

test("only the app's part of a slow click is compressed, ending before the pause", () => {
  const [seg] = planIdle(take([{ action: "click", start: 0, end: 13 }]), 1.5, [3]);
  assert.ok(seg, "10s of click before a 3s pause is still the app being slow");
  assert.ok(seg.to <= 10 + 1e-9, `compression stops where the pause begins (${seg.to})`);
});
