/** --brisk: all the steps, none of the pacing — and the one rule that keeps a
    brisk take from being mistaken for a finished one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canReuse, captureHash } from "../src/record.js";
import { loadManifest, type Manifest } from "../src/manifest.js";
import type { Take } from "../src/record.js";

/** A real manifest, through the real loader — captureHash resolves presets,
    so a hand-built object is not enough to test the thing being tested. */
function manifest(extraStep = false): Manifest {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brisk-m-"));
  const f = path.join(dir, "x.yaml");
  fs.writeFileSync(f, [
    "name: x",
    "url: http://localhost:3000",
    "preset: post-landscape",
    "steps:",
    "  - { action: scene, label: a }",
    "  - { action: click, selector: \".go\" }",
    ...(extraStep ? ["  - { action: click, selector: \".more\" }"] : []),
  ].join("\n"));
  return loadManifest(f).manifest;
}
const m = manifest();

function takeFor(extra: Partial<Take>): Take {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brisk-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  return { captureHash: captureHash(m), video, timeline: [], duration: 1, trimBefore: 0, ok: true, screenshots: [], startedAt: "", finishedAt: "", quality: { preset: "p", width: 1, height: 1, scale: 1, fps: 30 }, ...extra } as unknown as Take;
}

test("a matching take can be reused", () => {
  assert.equal(canReuse(takeFor({}), m), true);
});

test("a BRISK take can never be reused as the real thing", () => {
  // The capture hash is computed from the manifest, so a brisk take and a
  // paced one hash identically. Without this rule, --reuse quietly hands back
  // a recording with no pacing in it and nobody finds out until they watch it.
  assert.equal(captureHash(m), captureHash(m), "same manifest, same hash");
  assert.equal(canReuse(takeFor({ brisk: true }), m), false);
});

test("a fragment can never be reused either", () => {
  assert.equal(canReuse(takeFor({ partial: 'recorded from scene "x" (from) — a fragment' }), m), false);
});

test("a take of a different manifest is not reused", () => {
  const other = manifest(true);
  assert.equal(canReuse(takeFor({}), other), false);
});

test("a take whose video has gone is not reused", () => {
  const t = takeFor({});
  fs.unlinkSync(t.video!);
  assert.equal(canReuse(t, m), false);
});

test("no previous take at all is not an error", () => {
  assert.equal(canReuse(null, m), false);
  assert.equal(canReuse(undefined, m), false);
});

test("check FAILS a brisk take — it is correct and it is not shippable", async () => {
  // The audit caught this within hours of the feature landing: all the steps,
  // none of the pacing, and `check: pass`. The one line between an iteration
  // take and something being handed over as final.
  const { check } = await import("../src/render.js");
  const { ffmpeg } = await import("../src/ext/clip.js");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brisk-check-"));
  fs.mkdirSync(path.join(dir, "stills"));
  // A real (tiny) video, so `check` reaches its verdict instead of stopping
  // at "demo.mp4 missing" — the brisk line is near the end of the report.
  execFileSync(ffmpeg(), ["-y", "-f", "lavfi", "-i", "color=c=black:s=1920x1080:d=20:r=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "demo.mp4")], { stdio: ["ignore", "ignore", "pipe"] });
  fs.writeFileSync(path.join(dir, "stills", "01-a-end.png"), "");
  fs.writeFileSync(path.join(dir, "proof-log.md"), "#");
  fs.writeFileSync(path.join(dir, "thumbnail.png"), "");
  const base = {
    timeline: [{ index: 0, action: "scene", label: "a", start: 0, end: 0.1, ok: true, summary: "scene: a" }],
    duration: 20, trimBefore: 0, ok: true, screenshots: [], startedAt: "", finishedAt: "",
    quality: { preset: "post-landscape", width: 1920, height: 1080, scale: 2, fps: 30 },
  };
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({ ...base, brisk: true }));
  const brisk = check(dir);
  assert.equal(brisk.ok, false);
  assert.match(brisk.lines.join("\n"), /brisk/);

  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify(base));
  assert.doesNotMatch(check(dir).lines.join("\n"), /brisk/, "a normal take is never called brisk");
});
