import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Manifest, type Manifest as ManifestType } from "../src/manifest.js";
import { acquireLock, captureHash, releaseLock, type Take } from "../src/record.js";
import {
  assertFinalReceipt,
  captureMatchesTake,
  notePreviewCapture,
  notePreviewRender,
  readPreviewReceipt,
} from "../src/preview.js";

function manifest(preset: "preview-fast" | "post-landscape", focus = ".go"): ManifestType {
  return Manifest.parse({
    name: "x",
    url: "http://localhost:3000",
    preset,
    steps: [
      { action: "scene", label: "start", caption: "Start", camera: { focus, zoom: 1.4 } },
      { action: "click", selector: ".go" },
    ],
  });
}

function takeFor(m: ManifestType, video: string): Take {
  return {
    captureHash: captureHash(m),
    video,
    timeline: [],
    duration: 10,
    trimBefore: 0,
    ok: true,
    screenshots: [],
    startedAt: "2026-09-18T08:00:00Z",
    finishedAt: "2026-09-18T08:00:10Z",
    captureSec: 10,
    quality: { preset: "preview-fast", width: 1920, height: 1080, scale: 2, fps: 24 },
  };
}

function writeCliFixture(withReceipt: boolean): { root: string; dir: string; file: string; take: Take } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-cli-"));
  const dir = path.join(root, "outputs", "x");
  const demos = path.join(root, "demos");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(demos, { recursive: true });
  const file = path.join(demos, "x.json");
  fs.writeFileSync(file, JSON.stringify(manifest("post-landscape")));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "not needed: guards must run before rendering");
  const take = takeFor(manifest("preview-fast"), video);
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify(take));
  if (withReceipt) {
    notePreviewCapture(dir, take, 10, "preview-fast");
    notePreviewRender(dir, take, { preset: "preview-fast", seconds: 2, kind: "initial" });
  }
  return { root, dir, file, take };
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), ...args], { encoding: "utf8" });
}

test("a preview-fast take can publish as post-landscape without another capture", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = takeFor(manifest("preview-fast"), video);

  assert.equal(captureMatchesTake(take, manifest("post-landscape")), true);
});

test("a capture-relevant camera focus change still requires another take", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = takeFor(manifest("preview-fast"), video);

  assert.equal(captureMatchesTake(take, manifest("post-landscape", ".other")), false);
});

test("a failed take is never reusable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = { ...takeFor(manifest("preview-fast"), video), ok: false };

  assert.equal(captureMatchesTake(take, manifest("post-landscape")), false);
});

test("partial and brisk takes are never reusable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = takeFor(manifest("preview-fast"), video);

  assert.equal(captureMatchesTake({ ...take, partial: "fallback" }, manifest("post-landscape")), false);
  assert.equal(captureMatchesTake({ ...take, brisk: true }, manifest("post-landscape")), false);
});

test("the output lock rejects a second owner in the same process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-lock-"));
  acquireLock(dir);
  try {
    assert.throws(() => acquireLock(dir), /another retake run/i);
  } finally {
    releaseLock(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale output lock fails closed and a non-owner cannot release it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-lock-"));
  const lock = path.join(dir, ".retake-lock");
  fs.writeFileSync(lock, "999999999");
  try {
    assert.throws(() => acquireLock(dir), /stale.*delete/i);
    releaseLock(dir);
    assert.equal(fs.existsSync(lock), true, "release must not remove a lock owned by another process");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rendering without a matching capture receipt is rejected and creates nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = takeFor(manifest("preview-fast"), video);

  assert.throws(
    () => notePreviewRender(dir, take, { preset: "preview-fast", seconds: 2, kind: "initial" }),
    /capture receipt/i,
  );
  assert.equal(readPreviewReceipt(dir), null);
});

test("CLI final render refuses a missing receipt before touching the raw video", () => {
  const fixture = writeCliFixture(false);
  try {
    const result = runCli(["render", fixture.dir, fixture.file, "--final"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /requires a current preview capture receipt/i);
    assert.equal(fs.existsSync(path.join(fixture.dir, "facts.json")), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("CLI final run refuses to reopen the browser when a reusable preview exists", () => {
  const fixture = writeCliFixture(true);
  try {
    const result = runCli(["run", fixture.file, "--out", path.join(fixture.root, "outputs")]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /final quality must not record again/i);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.dir, "take.json"), "utf8")).finishedAt, fixture.take.finishedAt);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("one capture permits an initial preview, one correction, and one final render", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = takeFor(manifest("preview-fast"), video);

  notePreviewCapture(dir, take, 10, "preview-fast");
  notePreviewRender(dir, take, { preset: "preview-fast", seconds: 2, kind: "initial" });
  notePreviewRender(dir, take, { preset: "preview-fast", seconds: 1, kind: "correction" });
  notePreviewRender(dir, take, { preset: "post-landscape", seconds: 4, kind: "final" });

  const receipt = readPreviewReceipt(dir);
  assert.equal(receipt?.takeFinishedAt, take.finishedAt);
  assert.equal(receipt?.captureCount, 1);
  assert.equal(receipt?.renderCount, 3);
  assert.equal(receipt?.correctionsUsed, 1);
  assert.equal(receipt?.captureSec, 10);
  assert.equal(receipt?.renderSec, 7);
  assert.equal(receipt?.totalSec, 17);
  assert.equal(receipt?.previewPreset, "preview-fast");
  assert.equal(receipt?.finalPreset, "post-landscape");
  assert.equal(receipt?.renders.map((r) => r.kind).join(","), "initial,correction,final");
  assert.equal(receipt?.withinTarget, true);
  assert.equal(assertFinalReceipt(dir, take).finalPreset, "post-landscape");
  assert.throws(
    () => notePreviewRender(dir, take, { preset: "post-landscape", seconds: 1, kind: "final" }),
    /finalized/i,
  );
});

test("a second correction is rejected without consuming the final render", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = takeFor(manifest("preview-fast"), video);
  notePreviewCapture(dir, take, 10, "preview-fast");
  notePreviewRender(dir, take, { preset: "preview-fast", seconds: 2, kind: "initial" });
  notePreviewRender(dir, take, { preset: "preview-fast", seconds: 1, kind: "correction" });

  assert.throws(
    () => notePreviewRender(dir, take, { preset: "preview-fast", seconds: 1, kind: "correction" }),
    /correction budget/i,
  );
  notePreviewRender(dir, take, { preset: "post-landscape", seconds: 4, kind: "final" });
  assert.equal(assertFinalReceipt(dir, take).finalPreset, "post-landscape");
});

test("only post-landscape can close the preview workflow", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = takeFor(manifest("preview-fast"), video);
  notePreviewCapture(dir, take, 10, "preview-fast");
  notePreviewRender(dir, take, { preset: "preview-fast", seconds: 2, kind: "initial" });

  assert.throws(
    () => notePreviewRender(dir, take, { preset: "draft", seconds: 1, kind: "final" }),
    /post-landscape/i,
  );
  assert.throws(() => assertFinalReceipt(dir, take), /not been finalized/i);
});

test("receipt records the 180 second target honestly", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = takeFor(manifest("preview-fast"), video);
  notePreviewCapture(dir, take, 179, "preview-fast");
  const receipt = notePreviewRender(dir, take, { preset: "preview-fast", seconds: 2, kind: "initial" });

  assert.equal(receipt.targetSec, 180);
  assert.equal(receipt.withinTarget, false);
  assert.equal(receipt.overTargetSec, 1);
});

test("a new take starts a fresh receipt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const first = takeFor(manifest("preview-fast"), video);
  const second = { ...first, finishedAt: "2026-09-18T08:01:10Z" };

  notePreviewCapture(dir, first, 10, "preview-fast");
  notePreviewRender(dir, first, { preset: "preview-fast", seconds: 2, kind: "initial" });
  notePreviewCapture(dir, second, 8, "preview-fast");

  const receipt = readPreviewReceipt(dir);
  assert.equal(receipt?.version, 2);
  assert.equal(receipt?.takeFinishedAt, second.finishedAt);
  assert.equal(receipt?.captureCount, 1);
  assert.equal(receipt?.renderCount, 0);
  assert.equal(receipt?.correctionsUsed, 0);
  assert.equal(receipt?.captureSec, 8);
  assert.equal(receipt?.renderSec, 0);
  assert.equal(receipt?.totalSec, 8);
  assert.equal(receipt?.withinTarget, true);
  assert.equal(typeof receipt?.updatedAt, "string");
});

test("malformed or stale receipts cannot certify a final video", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-preview-"));
  const video = path.join(dir, "raw.webm");
  fs.writeFileSync(video, "x");
  const take = takeFor(manifest("preview-fast"), video);
  notePreviewCapture(dir, take, 10, "preview-fast");
  notePreviewRender(dir, take, { preset: "preview-fast", seconds: 2, kind: "initial" });
  notePreviewRender(dir, take, { preset: "post-landscape", seconds: 4, kind: "final" });

  assert.throws(() => assertFinalReceipt(dir, { ...take, finishedAt: "later" }), /stale/i);

  const file = path.join(dir, "preview.json");
  const malformed = JSON.parse(fs.readFileSync(file, "utf8"));
  malformed.renders[0].kind = "final";
  fs.writeFileSync(file, JSON.stringify(malformed));
  assert.equal(readPreviewReceipt(dir), null);
});
