import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Manifest, Step } from "../src/manifest.js";
import { voiceCachePath } from "../src/voice.js";

test("click and hover accept bounded multi-point cursor routes", () => {
  const click = Step.parse({
    action: "click",
    at: "#finish",
    via: [{ x: 120, y: 300 }, { selector: "#waypoint", dx: 8, dy: -4 }],
  });
  assert.equal(click.action, "click");
  assert.equal(click.via?.length, 2);
  assert.throws(() => Step.parse({ action: "hover", at: "#finish", via: Array.from({ length: 9 }, () => ({ x: 1, y: 1 })) }));
});

test("scene camera can hold a readable target and ease back out", () => {
  const scene = Step.parse({
    action: "scene",
    label: "focused",
    camera: { focus: "#target", zoom: 1.3, holdMs: 1800, easeMs: 550 },
  });
  assert.equal(scene.action, "scene");
  assert.deepEqual(scene.camera, { focus: "#target", zoom: 1.3, holdMs: 1800, easeMs: 550 });
});

test("voice cache keys include both voice and text", () => {
  const a = voiceCachePath("hello", "voice-a");
  assert.equal(a, voiceCachePath("hello", "voice-a"));
  assert.notEqual(a, voiceCachePath("hello", "voice-b"));
  assert.notEqual(a, voiceCachePath("different", "voice-a"));
  assert.notEqual(a, voiceCachePath("hello", "voice-a", 18));
  assert.match(path.basename(a), /^[a-f0-9]{64}\.mp3$/);
});

test("voiceover accepts a bounded speaking-rate adjustment", () => {
  const m = Manifest.parse({
    name: "faster-voice",
    title: "Faster voice",
    url: "https://example.com",
    voiceover: { voice: "ru-RU-SvetlanaNeural", ratePercent: 18, fragments: true, approved: true },
    steps: [{ action: "scene", label: "start", caption: "Начинаем." }],
  });
  assert.equal(typeof m.voiceover === "object" && m.voiceover.ratePercent, 18);
  assert.throws(() => Manifest.parse({
    name: "too-fast",
    title: "Too fast",
    url: "https://example.com",
    voiceover: { ratePercent: 80, fragments: true, approved: true },
    steps: [{ action: "scene", label: "start", caption: "Начинаем." }],
  }));
});

test("camera interpolation and initial readiness avoid abrupt and fixed waits", () => {
  const render = fs.readFileSync(path.join(process.cwd(), "src", "render.ts"), "utf8");
  const record = fs.readFileSync(path.join(process.cwd(), "src", "record.ts"), "utf8");
  const dry = fs.readFileSync(path.join(process.cwd(), "src", "dryrun.ts"), "utf8");
  assert.match(render, /\*\$\{p\}\*\$\{p\}\*\(3-2\*\$\{p\}\)/, "camera path must use smoothstep easing");
  assert.doesNotMatch(record.slice(record.indexOf("await page.goto(expandEnv(m.url)"), record.indexOf("layoutWidth =")), /networkidle/);
  assert.doesNotMatch(dry.slice(dry.indexOf("await page.goto(expandEnv(m.url)"), dry.indexOf("if \(opts.seed")), /networkidle/);
});
