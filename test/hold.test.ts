/** A narrated scene lasts as long as its paragraph — held at render, never re-recorded. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BREATH, holdFilterArgs, holdTime, planHolds } from "../src/hold.js";

test("only a scene shorter than its paragraph is held, by exactly the shortfall plus a breath", () => {
  const holds = planHolds([{ from: 1, to: 9 }, { from: 9, to: 30 }], [10, 6], 0.1);
  assert.equal(holds.length, 1, "the second scene already has room");
  assert.equal(holds[0].at, 9, "held at the end of the scene, on its settled frame");
  assert.ok(Math.abs(holds[0].seconds - (0.1 + 10 + BREATH - 8)) < 1e-9);
});

test("every moment after a hold moves by it; nothing before it does", () => {
  const holds = [{ at: 9, seconds: 2.7 }];
  assert.equal(holdTime(holds, 5), 5);
  assert.equal(holdTime(holds, 9), 11.7, "the next scene starts after the hold");
  assert.equal(holdTime(holds, 12), 14.7);
});

test("the render freezes the last frame of the piece before each hold", () => {
  const args = holdFilterArgs("in.mp4", [{ at: 9, seconds: 2.7 }], 20, "out.mp4");
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.match(graph, /trim=start=0\.000:end=9\.000,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=2\.700/);
  assert.match(graph, /trim=start=9\.000:end=20\.000/);
  assert.match(graph, /concat=n=2/);
});
