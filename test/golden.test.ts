import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { addGolden, goldenSetStatus, inspectMedia, loadGoldenLedger, scoreGolden, verifyGoldenIntegrity, writeGoldenScorecard } from "../src/ext/golden.js";
import { contactSheetFile, ffmpegBin } from "../src/render.js";

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "retake-golden-")); }
const RUBRIC = { story: "pass", framing: "pass", timing: "pass", text: "pass", motion: "pass" } as const;
const CLI = path.resolve("node_modules/.bin/tsx");
const CLI_SOURCE = path.resolve("src/cli.ts");

function video(dir: string, name: string, opts: { color?: string; seconds?: number; size?: string; fps?: number; audio?: boolean } = {}) {
  const out = path.join(dir, name);
  const color = opts.color ?? "blue";
  const seconds = opts.seconds ?? 1;
  const size = opts.size ?? "320x180";
  const fps = opts.fps ?? 30;
  const args = ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=${fps}:d=${seconds}`];
  if (opts.audio !== false) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`, "-shortest", "-c:a", "aac");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", out);
  execFileSync(ffmpegBin(), args);
  return out;
}

function contact(dir: string) {
  const file = path.join(dir, "contact.png");
  fs.writeFileSync(file, "approved contact sheet");
  return file;
}

test("registration requires explicit human approval and stores no source path or MP4", () => {
  const dir = root();
  try {
    const source = video(dir, "source.mp4");
    const sheet = contact(dir);
    assert.throws(() => addGolden(dir, source, { id: "sample", title: "Sample", approvedBy: "", rubric: RUBRIC, contact: sheet }), /approved-by/i);
    assert.throws(() => addGolden(dir, source, { id: "sample", title: "Sample", approvedBy: "Gleb", contact: sheet } as never), /completed rubric/i);
    addGolden(dir, source, { id: "sample", title: "Sample", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    const ledgerText = fs.readFileSync(path.join(dir, "index.json"), "utf8");
    assert.doesNotMatch(ledgerText, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(ledgerText, /source\.mp4/);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".mp4")).length, 1, "registration must not copy another MP4");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("same visual stream can carry multiple audio variants in one reference family", () => {
  const dir = root();
  try {
    const first = video(dir, "first.mp4");
    const second = path.join(dir, "second.mp4");
    execFileSync(ffmpegBin(), ["-v", "error", "-y", "-i", first, "-f", "lavfi", "-i", "sine=frequency=880:duration=1", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", second]);
    const sheet = contact(dir);
    addGolden(dir, first, { id: "family", title: "Family", approvedBy: "Gleb", rubric: RUBRIC, variant: "Ava", contact: sheet });
    addGolden(dir, second, { id: "family", title: "Family", approvedBy: "Gleb", rubric: RUBRIC, variant: "Emma", contact: sheet });
    const ledger = loadGoldenLedger(dir);
    assert.equal(ledger.references.length, 1);
    assert.equal(ledger.references[0].variants.length, 2);
    assert.equal(ledger.references[0].variants[0].videoSha256, ledger.references[0].variants[1].videoSha256);
    assert.notEqual(ledger.references[0].variants[0].audioSha256, ledger.references[0].variants[1].audioSha256);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("duplicate container is idempotent and a ninth visual reference is refused", () => {
  const dir = root();
  try {
    const sheet = contact(dir);
    const source = video(dir, "same.mp4");
    addGolden(dir, source, { id: "same", title: "Same", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    addGolden(dir, source, { id: "same", title: "Same", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    assert.equal(loadGoldenLedger(dir).references[0].variants.length, 1);
    for (let i = 1; i < 8; i++) {
      const f = video(dir, `${i}.mp4`, { color: i % 2 ? "red" : "green", seconds: 1 + i / 10 });
      addGolden(dir, f, { id: `ref-${i}`, title: `Ref ${i}`, approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    }
    assert.equal(goldenSetStatus(dir).complete, true);
    const ninth = video(dir, "ninth.mp4", { color: "yellow", seconds: 2.2 });
    assert.throws(() => addGolden(dir, ninth, { id: "ninth", title: "Ninth", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet }), /eight/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("scorecard passes matching media and names each mismatched criterion", () => {
  const dir = root();
  try {
    const sheet = contact(dir);
    const reference = video(dir, "reference.mp4", { size: "320x180", fps: 30 });
    addGolden(dir, reference, { id: "reference", title: "Reference", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    const passing = scoreGolden(dir, reference, "reference");
    assert.equal(passing.ok, true);
    const scorecard = writeGoldenScorecard(dir, passing);
    const text = fs.readFileSync(scorecard, "utf8");
    assert.doesNotMatch(text, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text, /containerSha256/);
    assert.match(text, /referenceVisualSha256/);
    const wrong = video(dir, "wrong.mp4", { size: "640x360", fps: 24, audio: false });
    const score = scoreGolden(dir, wrong, "reference");
    assert.equal(score.ok, false);
    assert.ok(score.rows.some((r) => r.name === "dimensions" && r.status === "fail"));
    assert.ok(score.rows.some((r) => r.name === "fps" && r.status === "fail"));
    assert.ok(score.rows.some((r) => r.name === "audio" && r.status === "fail"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("missing or unreadable media can never score as a pass", () => {
  const dir = root();
  try {
    assert.throws(() => inspectMedia(path.join(dir, "missing.mp4")), /does not exist/i);
    const bad = path.join(dir, "bad.mp4");
    fs.writeFileSync(bad, "not video");
    assert.throws(() => inspectMedia(bad), /readable video/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("fewer than five visual references is reported as incomplete", () => {
  const dir = root();
  try {
    assert.deepEqual(goldenSetStatus(dir), { count: 0, complete: false, message: "0 of 5 minimum approved visual references" });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("contact-sheet tampering invalidates the approved reference", () => {
  const dir = root();
  try {
    const source = video(dir, "source.mp4");
    const sheet = contact(dir);
    const reference = addGolden(dir, source, { id: "sample", title: "Sample", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    assert.equal(verifyGoldenIntegrity(dir, "sample").ok, true);
    fs.appendFileSync(path.join(dir, reference.contact), "changed after approval");
    const result = verifyGoldenIntegrity(dir, "sample");
    assert.equal(result.ok, false);
    assert.match(result.lines[0], /^FAIL/);
    assert.throws(() => scoreGolden(dir, source, "sample"), /integrity/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a duplicate container cannot report success for another family", () => {
  const dir = root();
  try {
    const source = video(dir, "source.mp4");
    const sheet = contact(dir);
    addGolden(dir, source, { id: "family-a", title: "A", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    const other = video(dir, "other.mp4", { color: "red" });
    addGolden(dir, other, { id: "family-b", title: "B", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    assert.throws(() => addGolden(dir, source, { id: "family-b", title: "B", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet }), /belongs to family-a/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canonical scorecards are byte-for-byte deterministic", () => {
  const dir = root();
  try {
    const source = video(dir, "source.mp4");
    const sheet = contact(dir);
    addGolden(dir, source, { id: "sample", title: "Sample", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    const first = writeGoldenScorecard(dir, scoreGolden(dir, source, "sample"));
    const before = fs.readFileSync(first);
    const second = writeGoldenScorecard(dir, scoreGolden(dir, source, "sample"));
    assert.deepEqual(fs.readFileSync(second), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a new family replaces stale evidence and publishes a canonical contact", () => {
  const dir = root();
  try {
    const source = video(dir, "source.mp4");
    const staleDir = path.join(dir, "sample");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "contact.png"), "stale evidence");
    const sheet = contact(dir);
    const reference = addGolden(dir, source, { id: "sample", title: "Sample", approvedBy: "Gleb", rubric: RUBRIC, contact: sheet });
    assert.equal(reference.contact, "sample/contact.png");
    assert.equal(fs.readFileSync(path.join(dir, reference.contact), "utf8"), "approved contact sheet");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("contact evidence explicitly includes the ending frame", () => {
  const dir = root();
  try {
    const source = video(dir, "source.mp4", { seconds: 4.2 });
    const lines: string[] = [];
    const sheet = contactSheetFile(source, path.join(dir, "sheet.png"), 2, 160, (line) => lines.push(line));
    assert.ok(fs.statSync(sheet).size > 0);
    assert.ok(lines.some((line) => /through 4\.1\d?s/.test(line)), lines.join("\n"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CLI validates approval identity before generating evidence outside the golden root", () => {
  const dir = root();
  const escaped = path.join(path.dirname(dir), `${path.basename(dir)}-escaped`);
  try {
    const source = video(dir, "source.mp4");
    const approvals = path.join(dir, ".approvals");
    fs.mkdirSync(approvals, { recursive: true });
    const receipt = path.join(approvals, "invalid.json");
    fs.writeFileSync(receipt, JSON.stringify({
      version: 1,
      kind: "retake-human-golden-approval",
      id: `../${path.basename(escaped)}`,
      title: "Invalid",
      approvedBy: "Gleb",
      approvedAt: new Date(0).toISOString(),
      sourceContainerSha256: inspectMedia(source).containerSha256,
      rubric: RUBRIC,
    }));
    const result = spawnSync(CLI, [CLI_SOURCE, "golden", "add", source, "--root", dir, "--approval-receipt", receipt], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /golden id/i);
    assert.equal(fs.existsSync(path.join(escaped, "contact.png")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(escaped, { recursive: true, force: true });
  }
});

test("CLI approval fails closed without an interactive human terminal", () => {
  const dir = root();
  try {
    const source = video(dir, "source.mp4");
    const result = spawnSync(CLI, [CLI_SOURCE, "golden", "approve", source, "--root", dir, "--id", "sample", "--title", "Sample", "--approved-by", "Gleb", "--rubric", "story=pass,framing=pass,timing=pass,text=pass,motion=pass"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /interactive human terminal/i);
    assert.equal(fs.existsSync(path.join(dir, ".approvals")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("golden verify exits nonzero until the 5-reference set is ready", () => {
  const dir = root();
  try {
    const result = spawnSync(CLI, [CLI_SOURCE, "golden", "verify", "--root", dir], { encoding: "utf8" });
    assert.equal(result.status, 3);
    assert.match(result.stdout, /INCOMPLETE\s+0 of 5/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
