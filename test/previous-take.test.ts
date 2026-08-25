/**
 * Losing a good recording to a FAILED re-record is the most expensive thing
 * this tool can do to someone. It happened: `run` deleted the output folder
 * and then started the browser, so a crash between the two left neither the
 * new take nor the old one.
 *
 * These lock the rule: the old artifacts survive until a new take exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KEEP_TAKES, keepPrevious, keptTakes, restoreKept, restorePrevious, stashPrevious } from "../src/record.js";

const take = (ok = true, at = "2026-08-25T10:00:00.000Z") => JSON.stringify({
  ok, duration: 12, trimBefore: 2, finishedAt: at, startedAt: at,
  timeline: [{ index: 0, action: "scene", summary: "s", start: 0, end: 1, ok: true }],
  screenshots: [], quality: { preset: "draft", width: 960, height: 540, scale: 1, fps: 15 },
});

const seeded = (ok = true, at?: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "retake-prev-"));
  fs.writeFileSync(path.join(d, "demo.mp4"), "the good take");
  fs.writeFileSync(path.join(d, "raw.webm"), "RAW RECORDING");
  fs.writeFileSync(path.join(d, "take.json"), take(ok, at));
  fs.mkdirSync(path.join(d, "stills"));
  fs.writeFileSync(path.join(d, "stills", "01-start.png"), "png");
  fs.writeFileSync(path.join(d, ".retake-lock"), "123");
  return d;
};

test("a failed recording gives the previous take back, whole", () => {
  const d = seeded();
  stashPrevious(d);
  assert.equal(fs.existsSync(path.join(d, "demo.mp4")), false, "moved aside during the take");
  assert.equal(restorePrevious(d), true);
  assert.equal(fs.readFileSync(path.join(d, "demo.mp4"), "utf8"), "the good take");
  assert.equal(fs.readFileSync(path.join(d, "stills", "01-start.png"), "utf8"), "png", "directories come back too");
  fs.rmSync(d, { recursive: true, force: true });
});

test("the lock is left alone, so it still guards the folder", () => {
  const d = seeded();
  stashPrevious(d);
  assert.equal(fs.readFileSync(path.join(d, ".retake-lock"), "utf8"), "123");
  fs.rmSync(d, { recursive: true, force: true });
});

test("a chosen poster survives a re-record", () => {
  const d = seeded();
  fs.writeFileSync(path.join(d, ".poster"), '{"at":3}');
  stashPrevious(d);
  assert.equal(fs.existsSync(path.join(d, ".poster")), true, "the poster is a choice, not an artifact");
  fs.rmSync(d, { recursive: true, force: true });
});

test("a successful take keeps the old one as a version — recording only", () => {
  const d = seeded();
  stashPrevious(d);
  fs.writeFileSync(path.join(d, "demo.mp4"), "the new take");
  keepPrevious(d);
  assert.equal(fs.existsSync(path.join(d, ".previous")), false, "the stash is consumed");
  assert.equal(fs.readFileSync(path.join(d, "demo.mp4"), "utf8"), "the new take");
  const kept = keptTakes(d);
  assert.equal(kept.length, 1);
  const files = fs.readdirSync(path.join(d, ".history", kept[0].id)).sort();
  assert.deepEqual(files, ["raw.webm", "take.json"], "derived files are not stored — they re-render");
  fs.rmSync(d, { recursive: true, force: true });
});

test("a FAILED take is not kept — nobody wants to go back to it", () => {
  const d = seeded(false);
  stashPrevious(d);
  keepPrevious(d);
  assert.equal(keptTakes(d).length, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test(`only the newest ${KEEP_TAKES} versions are kept`, () => {
  const d = seeded(true, "2026-08-20T10:00:00.000Z");
  for (let i = 0; i < KEEP_TAKES + 3; i++) {
    fs.writeFileSync(path.join(d, "take.json"), take(true, `2026-08-2${i}T10:00:00.000Z`));
    fs.writeFileSync(path.join(d, "raw.webm"), `RAW ${i}`);
    stashPrevious(d);
    keepPrevious(d);
  }
  assert.equal(keptTakes(d).length, KEEP_TAKES, "history is bounded, not a pile of videos");
  fs.rmSync(d, { recursive: true, force: true });
});

test("a kept version can be restored and is the real recording", () => {
  const d = seeded();
  stashPrevious(d);
  fs.writeFileSync(path.join(d, "demo.mp4"), "the new take");
  fs.writeFileSync(path.join(d, "raw.webm"), "NEW RAW");
  keepPrevious(d);
  const [old] = keptTakes(d);
  assert.equal(restoreKept(d, old.id), true);
  assert.equal(fs.readFileSync(path.join(d, "raw.webm"), "utf8"), "RAW RECORDING", "the original recording is back");
  const t = JSON.parse(fs.readFileSync(path.join(d, "take.json"), "utf8"));
  assert.equal(t.video, path.join(d, "raw.webm"), "and take.json points at it where it now lives");
  fs.rmSync(d, { recursive: true, force: true });
});

test("a stash left by a killed process is restored by the next run", () => {
  const d = seeded();
  stashPrevious(d);           // process dies here — no catch ever runs
  assert.equal(fs.existsSync(path.join(d, ".previous")), true);
  stashPrevious(d);           // the next run
  assert.equal(fs.existsSync(path.join(d, ".previous", "demo.mp4")), true);
  restorePrevious(d);
  assert.equal(fs.readFileSync(path.join(d, "demo.mp4"), "utf8"), "the good take", "still the original, not lost to a second stash");
  fs.rmSync(d, { recursive: true, force: true });
});

test("an empty output folder is not a problem", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "retake-prev-"));
  stashPrevious(d);
  assert.equal(restorePrevious(d), false);
  fs.rmSync(d, { recursive: true, force: true });
});
