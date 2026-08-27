/** heal: restoring a demo file must not create a second demo with the same
    name as an existing one. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeOrphans, findOrphans, healOrphans, renameTo } from "../src/ext/heal.js";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heal-"));
  const out = path.join(root, "outputs"), demos = path.join(root, "demos");
  fs.mkdirSync(out); fs.mkdirSync(demos);
  return { out, demos };
}

function recording(out: string, folder: string, innerName: string) {
  const dir = path.join(out, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.used.yaml"), `name: ${innerName}\nurl: http://localhost:3000\nsteps: []\n`);
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({ finishedAt: "2026-08-27T10:00:00Z", duration: 10, trimBefore: 0 }));
  fs.writeFileSync(path.join(dir, "demo.mp4"), "x");
}

test("a restored fragment is renamed to its own folder, not the demo it came from", () => {
  // This shipped wrong: a --from take keeps the PARENT demo's name in its used
  // manifest, so restoring two fragments of one demo wrote three files all
  // saying `name: avex-full-flow`, and the window showed that demo three
  // times. It looked broken because it was.
  const { out, demos } = workspace();
  recording(out, "avex-full-flow", "avex-full-flow");
  recording(out, "avex-draft-check", "avex-full-flow");   // a --from fragment
  recording(out, "avex-tail-check", "avex-full-flow");    // another one
  healOrphans(findOrphans(out, demos), demos);

  const names = fs.readdirSync(demos).map((f) => /^name:\s*(.+)$/m.exec(fs.readFileSync(path.join(demos, f), "utf8"))![1]);
  assert.equal(new Set(names).size, names.length, `every restored demo needs its own name, got: ${names.join(", ")}`);
  assert.deepEqual(names.sort(), ["avex-draft-check", "avex-full-flow", "avex-tail-check"]);
});

test("a manifest whose name already matches is left byte-for-byte alone", () => {
  const src = "# a comment\nname: demo\nurl: http://x\n";
  assert.equal(renameTo(src, "demo"), src);
});

test("renaming touches only the name line", () => {
  const src = "# keep me\nname: old\nurl: http://x\nsteps: []\n";
  assert.equal(renameTo(src, "new"), "# keep me\nname: new\nurl: http://x\nsteps: []\n");
});

test("a manifest with no name at all gets one", () => {
  assert.match(renameTo("url: http://x\n", "demo"), /^name: demo\n/);
});

test("a demo file a person already wrote is never overwritten", () => {
  const { out, demos } = workspace();
  fs.writeFileSync(path.join(demos, "mine.yaml"), "name: mine\n# hand written\n");
  recording(out, "mine", "something-else");
  healOrphans(findOrphans(out, demos), demos);
  assert.match(fs.readFileSync(path.join(demos, "mine.yaml"), "utf8"), /hand written/);
});

test("a --from fragment is never restored as a demo of its own", () => {
  // Restoring two of them put two rows in the library that were not demos at
  // all — pieces of avex-full-flow, recorded while iterating, showing up as
  // failed demos next to it.
  const { out, demos } = workspace();
  const dir = path.join(out, "avex-tail-check");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.used.yaml"), "name: avex-full-flow\nurl: http://x\nsteps: []\n");
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({ finishedAt: "2026-08-25T12:20:00Z", duration: 96, trimBefore: 0, partial: 'recorded from scene "x" (from) — a fragment for iteration, not a finished cut' }));
  fs.writeFileSync(path.join(dir, "demo.mp4"), "x");

  const found = findOrphans(out, demos);
  assert.equal(found.length, 1);
  assert.ok(found[0].fragment, "it is recognised as a fragment");
  assert.deepEqual(healOrphans(found, demos), [], "and nothing is written");
  assert.deepEqual(fs.readdirSync(demos), []);
});

test("when everything found is a fragment, it does not tell you to run --apply", () => {
  const { out, demos } = workspace();
  const dir = path.join(out, "frag");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.used.yaml"), "name: parent\nurl: http://x\nsteps: []\n");
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({ finishedAt: "2026-08-25T12:20:00Z", partial: 'stopped after scene "x" (until)' }));
  fs.writeFileSync(path.join(dir, "demo.mp4"), "x");
  const lines = describeOrphans(findOrphans(out, demos), null).join("\n");
  assert.doesNotMatch(lines, /--apply/);
  assert.match(lines, /pieces of other demos/);
});
