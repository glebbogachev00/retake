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
