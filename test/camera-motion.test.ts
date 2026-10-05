import { test } from "node:test";
import assert from "node:assert/strict";
import { cameraKeys } from "../src/render.js";
import type { Take } from "../src/record.js";

function take(timeline: Take["timeline"], duration = 10): Take {
  return {
    timeline,
    duration,
    trimBefore: 0,
    screenshots: [],
    startedAt: "2026-09-18T00:00:00.000Z",
    finishedAt: "2026-09-18T00:00:10.000Z",
    ok: true,
    quality: { preset: "post-landscape", width: 1920, height: 1080, scale: 1, fps: 30 },
  };
}

const scene = (label: string, start: number, camera?: NonNullable<Take["timeline"][number]["camera"]>): Take["timeline"][number] => ({
  index: start,
  action: "scene",
  summary: label,
  label,
  start,
  end: start,
  ok: true,
  camera,
});

const cam = (x: number, holdMs?: number) => ({
  zoom: 1.3,
  box: { x, y: 300, width: 180, height: 100 },
  focus: `#target-${x}`,
  ...(holdMs === undefined ? {} : { holdMs }),
});

test("a single camera emphasis always returns smoothly to the wide frame", () => {
  const motion = cameraKeys(take([
    scene("focus", 1, cam(200)),
    scene("wide", 6),
  ]), 1920, 1080);

  assert.equal(motion.count, 1);
  assert.equal(motion.keys[0].z, 1, "starts wide");
  assert.ok(motion.keys.some((key) => key.z > 1.2), "zooms in");
  assert.equal(motion.keys.at(-1)?.z, 1, "returns wide instead of locking zoom");
  assert.ok((motion.keys.at(-1)?.t ?? 99) < 6, "finishes the zoom-out before the next section");
});

test("adjacent focused scenes form one camera shot instead of pumping wide between clicks", () => {
  const motion = cameraKeys(take([
    scene("first", 1, cam(200)),
    scene("second", 3, cam(900)),
    scene("wide", 7),
  ]), 1920, 1080);

  const middle = motion.keys.filter((key) => key.t > 1 && key.t < 4.5);
  assert.ok(middle.every((key) => key.z > 1), "camera stays in one focused shot while reframing");
  assert.equal(motion.keys.at(-1)?.z, 1, "the grouped shot still releases to wide once");
});

test("an explicit hold still releases once, even at the end of the take", () => {
  const motion = cameraKeys(take([scene("focus", 1, cam(500, 1400))], 8), 1920, 1080);
  const peak = motion.keys.findIndex((key) => key.z > 1.2);
  assert.ok(peak >= 0);
  assert.ok(motion.keys.slice(peak + 1).some((key) => key.z > 1.2), "holds the focused framing");
  assert.equal(motion.keys.at(-1)?.z, 1, "never leaves the final frame zoomed in");
});

test("camera scenes removed by head trim cannot lock the retained video zoomed", () => {
  const source = take([
    scene("trimmed-focus", 1, cam(200)),
    scene("trimmed-wide", 2),
    scene("retained-wide", 6),
  ], 10);
  source.trimBefore = 5;

  const motion = cameraKeys(source, 1920, 1080);

  assert.equal(motion.count, 0, "does not choreograph camera shots outside the retained timeline");
  assert.deepEqual(motion.keys, []);
});

test("an explicit hold inside adjacent focused scenes does not pump back to wide", () => {
  const motion = cameraKeys(take([
    scene("first", 1, cam(200, 1200)),
    scene("second", 3, cam(900)),
    scene("wide", 7),
  ]), 1920, 1080);

  const betweenTargets = motion.keys.filter((key) => key.t > 1.5 && key.t < 3.7);
  assert.ok(betweenTargets.length > 0);
  assert.ok(betweenTargets.every((key) => key.z > 1), "stays focused through the adjacent shot");
  assert.equal(motion.keys.at(-1)?.z, 1, "releases only after the grouped shot ends");
});
