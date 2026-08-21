/**
 * The structural verbs: insert_step and set_step.
 *
 * What matters: a new step lands where asked, is validated before it is let
 * in, leaves every other line — comments included — exactly as it was, and a
 * bad edit changes nothing on disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { applyEdits } from "../src/edits.js";
import { Manifest } from "../src/manifest.js";

const FIXTURE = `name: fixture
title: A fixture        # the title comment must survive
url: http://localhost:3000
preset: post-landscape
steps:
  # opening beat
  - { action: scene, label: start, caption: "Where it begins" }
  - { action: click, selector: "#go" }          # the click comment must survive
  - { action: type, selector: "#name", text: "Ada", delay: 40 }
  - { action: scene, label: end, caption: "Done" }
`;

function withFixture(run: (file: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-edits-"));
  const file = path.join(dir, "fixture.yaml");
  fs.writeFileSync(file, FIXTURE);
  try { run(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const stepsOf = (file: string) => (YAML.parse(fs.readFileSync(file, "utf8")) as { steps: { action: string; selector?: string; label?: string }[] }).steps;

test("insert_step after an index puts the step exactly there", () => withFixture((file) => {
  const r = applyEdits(file, [{ op: "insert_step", after: 1, step: { action: "waitFor", selector: ".result", timeout: 9000 } }]);
  assert.equal(r.skipped.length, 0, r.skipped.join("; "));
  assert.equal(r.rerecord, true);
  const steps = stepsOf(file);
  assert.equal(steps.length, 5);
  assert.deepEqual([steps[2].action, steps[2].selector], ["waitFor", ".result"]);
  assert.equal(steps[1].selector, "#go", "the neighbour before is untouched");
  assert.equal(steps[3].action, "type", "the neighbour after shifted down intact");
}));

test("insert_step with after: -1 inserts at the very start", () => withFixture((file) => {
  applyEdits(file, [{ op: "insert_step", after: -1, step: { action: "wait", ms: 500 } }]);
  const steps = stepsOf(file);
  assert.equal(steps[0].action, "wait");
  assert.equal(steps[1].label, "start");
}));

test("set_step replaces one step in place and nothing else", () => withFixture((file) => {
  const r = applyEdits(file, [{ op: "set_step", step: 2, value: { action: "fill", selector: "#name", text: "Grace" } }]);
  assert.equal(r.skipped.length, 0, r.skipped.join("; "));
  const steps = stepsOf(file) as { action: string; text?: string }[];
  assert.equal(steps.length, 4);
  assert.deepEqual([steps[2].action, steps[2].text], ["fill", "Grace"]);
  assert.equal(steps[1].action, "click");
  assert.equal(steps[3].action, "scene");
}));

test("comments survive a structural edit", () => withFixture((file) => {
  applyEdits(file, [{ op: "insert_step", after: 0, step: { action: "wait", ms: 800 } }]);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /the title comment must survive/);
  assert.match(text, /opening beat/);
  assert.match(text, /the click comment must survive/);
  assert.ok(Manifest.safeParse(YAML.parse(text)).success, "still a valid manifest");
}));

test("an invalid step is refused and the file is untouched", () => withFixture((file) => {
  const before = fs.readFileSync(file, "utf8");
  const r = applyEdits(file, [{ op: "insert_step", after: 1, step: { action: "click" } }]); // click needs a selector
  assert.equal(r.done.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /invalid step/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
}));

test("an out-of-range index is refused with the valid range named", () => withFixture((file) => {
  const r = applyEdits(file, [{ op: "insert_step", after: 99, step: { action: "wait", ms: 100 } }]);
  assert.equal(r.done.length, 0);
  assert.match(r.skipped[0], /after must be -1 \(start\) … 3/);
}));

test("a repair sequence reads like one: replace, insert, delete", () => withFixture((file) => {
  // The distill shape: a wrong wait, a missing click, a dead step.
  const r = applyEdits(file, [
    { op: "set_step", step: 1, value: { action: "click", selector: "button[aria-label=Distill]" } },
    { op: "insert_step", after: 1, step: { action: "waitFor", selector: ".distill-turn.assistant", timeout: 30000 } },
    { op: "delete_step", step: 3 },
  ]);
  assert.equal(r.skipped.length, 0, r.skipped.join("; "));
  const steps = stepsOf(file);
  assert.deepEqual(steps.map((s) => s.action), ["scene", "click", "waitFor", "scene"]);
}));
