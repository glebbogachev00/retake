/**
 * A re-record should not pay for the part that did not change.
 *
 * `--from` already made that possible and nobody used it: of four takes of
 * one 251-step demo, the two that used it were mine and the two the agent
 * made were full re-records at twice the cost. So the tool says it instead
 * of waiting to be asked — but only when it is true, because a suggestion
 * that fires on every run is one people learn to skip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { unchangedUpTo } from "../src/record.js";

const base = () => ({
  name: "d", url: "http://localhost:3000", preset: "draft",
  steps: [
    { action: "scene", label: "one" },
    { action: "fill", selector: "#a", text: "1" },
    { action: "fill", selector: "#b", text: "2" },
    { action: "scene", label: "two" },
    { action: "fill", selector: "#c", text: "3" },
    { action: "fill", selector: "#d", text: "4" },
    { action: "scene", label: "three" },
    { action: "fill", selector: "#e", text: "5" },
  ],
});

const withPrevious = (prev: unknown) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "retake-hint-"));
  fs.writeFileSync(path.join(d, "manifest.used.yaml"), YAML.stringify(prev));
  return d;
};

test("no previous take means no suggestion", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "retake-hint-"));
  assert.equal(unchangedUpTo(base() as never, d), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test("nothing changed at all — say nothing, there is no saving to offer", () => {
  const d = withPrevious(base());
  assert.equal(unchangedUpTo(base() as never, d), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test("a change in the tail resumes at the scene before it", () => {
  const d = withPrevious(base());
  const next = base();
  next.steps[7].text = "changed";
  const u = unchangedUpTo(next as never, d);
  assert.deepEqual(u, { scene: "three", steps: 6 });
  fs.rmSync(d, { recursive: true, force: true });
});

test("a change in the middle resumes at the scene before THAT, never after", () => {
  const d = withPrevious(base());
  const next = base();
  next.steps[4].text = "changed";
  const u = unchangedUpTo(next as never, d)!;
  assert.equal(u.scene, "two");
  assert.ok(u.steps <= 4, "resuming after the change would miss it");
  fs.rmSync(d, { recursive: true, force: true });
});

test("a change in the very first steps offers nothing worth having", () => {
  const d = withPrevious(base());
  const next = base();
  next.steps[1].text = "changed";
  const u = unchangedUpTo(next as never, d);
  assert.ok(!u || u.steps <= 1, "there is no head to keep");
  fs.rmSync(d, { recursive: true, force: true });
});

test("a changed url invalidates the whole recording, not just the tail", () => {
  const d = withPrevious(base());
  const next = base();
  next.url = "http://localhost:9999";
  next.steps[7].text = "changed";
  assert.equal(unchangedUpTo(next as never, d), null, "nothing recorded against the old url can be kept");
  fs.rmSync(d, { recursive: true, force: true });
});
