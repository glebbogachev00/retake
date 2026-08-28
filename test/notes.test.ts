/** The watcher. Every test here is really the same test: does it only say
    things that are true of the files on disk. A report that cries wolf once
    is a report nobody reads again. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { collect, notes } from "../src/ext/notes.js";

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "notes-")); }

/** A run on disk, as `record` would leave it. */
function run(rt: string, name: string, take: Record<string, unknown>, used?: Record<string, unknown>, priors = 0) {
  const dir = path.join(rt, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({
    timeline: [], duration: 10, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    ok: true, trimBefore: 0, screenshots: [], quality: { preset: "post-landscape", width: 1920, height: 1080, scale: 2, fps: 30 },
    ...take,
  }));
  if (used) fs.writeFileSync(path.join(dir, "manifest.used.yaml"), YAML.stringify(used));
  for (let i = 0; i < priors; i++) fs.mkdirSync(path.join(dir, ".history", `old-${i}`), { recursive: true });
  return dir;
}

const flat = (rt: string) => collect(rt).notes.map((n) => `${n.kind}: ${n.line}`).join("\n");

test("a --from fragment is not called a failure", () => {
  // This one shipped wrong the first time: `partial` is set both by a
  // deliberate fragment and by a take that fell over, and reading them as one
  // thing flagged the cheap-iteration path as broken.
  const rt = root();
  run(rt, "tail", { partial: 'recorded from scene "x" (from) — a fragment for iteration, not a finished cut' });
  const out = flat(rt);
  assert.doesNotMatch(out, /problem/);
  assert.match(out, /fragment from iterating/);
});

test("a take that fell over IS called a failure", () => {
  const rt = root();
  run(rt, "died", { partial: "run aborted: target closed", ok: false });
  assert.match(flat(rt), /problem: died kept a video from a run that did not finish cleanly/);
});

test("a stub that answered nothing is reported — the take passes and the demo lies", () => {
  const rt = root();
  run(rt, "canned", { stubbed: ["/api/x"], stubHits: { "/api/x": 0 } });
  assert.match(flat(rt), /never answered a single request/);
});

test("a stub that did answer is silent", () => {
  const rt = root();
  run(rt, "canned", { stubbed: ["/api/x"], stubHits: { "/api/x": 4 } });
  assert.doesNotMatch(flat(rt), /never answered/);
});

test("the same selector failing in two demos is one note, not two", () => {
  const rt = root();
  const failing = { timeline: [{ index: 1, action: "click", summary: 'click .buy-now', ok: false, error: "timeout", start: 0, end: 1 }], ok: false };
  run(rt, "a", failing);
  run(rt, "b", failing);
  const ns = collect(rt).notes.filter((n) => /failed in 2 different demos/.test(n.line));
  assert.equal(ns.length, 1);
  assert.deepEqual(ns[0].demos.sort(), ["a", "b"]);
});

test("a selector that failed in only one demo is not blamed on the app", () => {
  const rt = root();
  run(rt, "a", { timeline: [{ index: 1, action: "click", summary: "click .buy-now", ok: false, error: "timeout", start: 0, end: 1 }], ok: false });
  assert.doesNotMatch(flat(rt), /different demos/);
});

test("re-recorded with no expect anywhere → the note the watcher exists for, with a policy", () => {
  const rt = root();
  run(rt, "unchecked", {}, { steps: [{ action: "scene", label: "a" }, { action: "scene", label: "b" }] }, 2);
  const ns = collect(rt).notes.filter((n) => /no `expect:` on any scene/.test(n.line));
  assert.equal(ns.length, 1);
  assert.equal(ns[0].kind, "habit");
  assert.match(ns[0].policy!, /verify/);
  // And it must not tell somebody their recording is unfinished. The checks
  // are optional services run against a take that already exists.
  assert.doesNotMatch(ns[0].policy!, /not finished until|called finished/);
});

test("a demo with SOME expects is not called unchecked", () => {
  // It said "nothing has ever checked how it looks" about a demo carrying
  // seventeen expectations that verify had just answered.
  const rt = root();
  run(rt, "mixed", {}, { steps: [
    { action: "scene", label: "a", expect: "something" },
    { action: "scene", label: "b" },
    { action: "scene", label: "c" },
  ] }, 2);
  assert.doesNotMatch(flat(rt), /no `expect:` on any scene/);
});

test("scenes that DO carry expect are silent", () => {
  const rt = root();
  run(rt, "checked", {}, { steps: [{ action: "scene", label: "a", expect: "a board" }, { action: "scene", label: "b", expect: "two items" }] }, 2);
  assert.doesNotMatch(flat(rt), /no `expect:` on any scene/);
});

test("a take nobody has verified or swept is said out loud", () => {
  // The workspace-level version of "did the agent actually check it". Unlike
  // the agent's own answer, this one is on disk.
  const rt = root();
  run(rt, "unlooked", { finishedAt: "2026-08-27T10:00:00Z" }, { steps: [{ action: "scene", label: "a", expect: "x" }] });
  assert.match(flat(rt), /nobody has looked at how/);
});

test("a take that HAS been looked at is not nagged about", () => {
  const rt = root();
  const dir = run(rt, "looked", { finishedAt: "2026-08-27T10:00:00Z" }, { steps: [{ action: "scene", label: "a", expect: "x" }] });
  fs.writeFileSync(path.join(dir, "checks.json"), JSON.stringify({
    verify: { at: "now", takeFinishedAt: "2026-08-27T10:00:00Z", ok: true, count: 1, summary: "1 answered yes" },
  }));
  assert.doesNotMatch(flat(rt), /nobody has looked at how/);
});

test("a check answering an OLDER take does not count as looked at", () => {
  // A re-record makes every previous answer stale. Treating a stale pass as a
  // pass is the whole failure mode.
  const rt = root();
  const dir = run(rt, "restale", { finishedAt: "2026-08-27T12:00:00Z" }, { steps: [{ action: "scene", label: "a", expect: "x" }] });
  fs.writeFileSync(path.join(dir, "checks.json"), JSON.stringify({
    verify: { at: "then", takeFinishedAt: "2026-08-26T09:00:00Z", ok: true, count: 1, summary: "1 answered yes" },
  }));
  assert.match(flat(rt), /nobody has looked at how/);
});

test("a fresh lock is left alone; an hour-old one is a dead run holding the folder", () => {
  const rt = root();
  const dir = run(rt, "held", {});
  const lock = path.join(dir, ".retake-lock");
  fs.writeFileSync(lock, "1");
  assert.doesNotMatch(flat(rt), /still has a lock/);
  const old = Date.now() - 3 * 60 * 60_000;
  fs.utimesSync(lock, old / 1000, old / 1000);
  assert.match(flat(rt), /still has a lock on it from over an hour ago/);
});

test("nothing to report says so in one line, and never invents a fifth", () => {
  const rt = root();
  const dir = run(rt, "clean", { finishedAt: "2026-08-27T10:00:00Z" }, { steps: [{ action: "scene", label: "a", expect: "something" }] });
  fs.writeFileSync(path.join(dir, "checks.json"), JSON.stringify({
    verify: { at: "now", takeFinishedAt: "2026-08-27T10:00:00Z", ok: true, count: 1, summary: "1 answered yes" },
  }));
  const out = notes(rt);
  assert.equal(out.notes.length, 0);
  assert.equal(out.lines.length, 1);
  assert.match(out.lines[0], /nothing worth flagging/);
});

test("an empty outputs/ is not an error", () => {
  assert.match(notes(root()).lines[0], /Nothing recorded/);
});

test("the report is capped at five, problems first, and says how many it held back", () => {
  const rt = root();
  // Six distinct selectors, each failing in two demos — six separate notes.
  // (One dead stub across eight demos would be ONE note listing eight names,
  // which is the point: the report groups, it does not repeat itself.)
  for (let i = 0; i < 6; i++) {
    const failing = { timeline: [{ index: 1, action: "click", summary: `click .sel-${i}`, ok: false, error: "timeout", start: 0, end: 1 }], ok: false };
    run(rt, `a${i}`, failing);
    run(rt, `b${i}`, failing);
  }
  const out = notes(rt);
  const shown = out.lines.filter((l) => /^ {2}[✗·→]/.test(l));
  assert.ok(shown.length <= 5, `showed ${shown.length}`);
  assert.match(out.lines.join("\n"), /more — `retake notes --all`/);
  assert.ok(notes(rt, { all: true }).lines.filter((l) => /^ {2}[✗·→]/.test(l)).length > 5);
});

test("older than the window is not read back", () => {
  const rt = root();
  run(rt, "ancient", { finishedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(), partial: "run aborted: x" });
  assert.equal(collect(rt).runs.length, 0);
  assert.match(notes(rt).lines[0], /Nothing recorded/);
});
