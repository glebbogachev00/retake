/** The ledger, and the one promise that matters: it never edits a file a
    person wrote. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkFlags, flag, flagsPath, readFlags, unflag } from "../src/ext/flags.js";
import { sceneAt } from "../src/ext/clip.js";
import type { Manifest } from "../src/manifest.js";
import type { Take } from "../src/record.js";

const YAML_SRC = `# a comment that must survive
name: demo
url: http://localhost:3000
steps:
  - { action: scene, label: form, holdMs: 2600,
      expect: ["one thing", "another thing"] }
  - { action: type, selector: "#a", text: "hi" }
  - { action: scene, label: done }
`;

function demo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flags-"));
  const file = path.join(dir, "demo.yaml");
  fs.writeFileSync(file, YAML_SRC);
  return file;
}

test("flagging never touches the manifest — not one byte", () => {
  // The first version wrote the expectation into the YAML. A document
  // round-trip re-emits every node, so one added sentence reflowed a 280-line
  // file and dropped quotes from strings containing commas. Editing somebody's
  // source to record a note is not a trade worth making.
  const file = demo();
  const r = flag(file, { scene: "form", question: "q", expect: "the total covers both legs" });
  assert.ok("flag" in r);
  assert.equal(fs.readFileSync(file, "utf8"), YAML_SRC);
});

test("the ledger sits beside the manifest, and survives", () => {
  const file = demo();
  flag(file, { scene: "form", question: "q", expect: "a" });
  assert.equal(flagsPath(file), file.replace(/\.yaml$/, ".flags.json"));
  assert.ok(fs.existsSync(flagsPath(file)));
  assert.equal(readFlags(file).length, 1);
});

test("a scene that does not exist is refused, and the message names the ones that do", () => {
  const file = demo();
  const r = flag(file, { scene: "nope", question: "q", expect: "a" });
  assert.ok("error" in r);
  assert.match(r.error, /"form"/);
  assert.match(r.error, /"done"/);
  assert.equal(readFlags(file).length, 0);
});

test("the same thing cannot be flagged twice", () => {
  const file = demo();
  flag(file, { scene: "form", question: "q", expect: "a" });
  assert.ok("error" in flag(file, { scene: "form", question: "q", expect: "a" }));
  assert.equal(readFlags(file).length, 1);
});

test("ids are stable across recordings — that is what survives a re-record", () => {
  const a = demo(), b = demo();
  const x = flag(a, { scene: "form", question: "one wording", expect: "the total covers both legs" });
  const y = flag(b, { scene: "form", question: "a different wording", expect: "the total covers both legs" });
  assert.ok("flag" in x && "flag" in y);
  assert.equal(x.flag.id, y.flag.id);
});

test("unflag removes by id or by the sentence", () => {
  const file = demo();
  const r = flag(file, { scene: "form", question: "q", expect: "a sentence" });
  assert.ok("flag" in r);
  assert.ok("error" in unflag(file, "nothing like this"));
  assert.ok("removed" in unflag(file, "a sentence"));
  assert.equal(readFlags(file).length, 0);
});

test("nothing flagged says so, and does not pretend to have checked", async () => {
  const file = demo();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  const r = await checkFlags(file, {} as Manifest, out);
  assert.equal(r.checked.length, 0);
  assert.match(r.lines[0], /nothing flagged/);
});

test("flagged but never recorded is not a pass", async () => {
  const file = demo();
  flag(file, { scene: "form", question: "q", expect: "a" });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"));
  const r = await checkFlags(file, {} as Manifest, out);
  assert.equal(r.checked.length, 0);
  assert.match(r.lines[0], /has not been recorded/);
});

const take = (scenes: [string, number][], trimBefore = 3): Take => ({
  timeline: scenes.map(([label, start], i) => ({ index: i, action: "scene", label, start, end: start, ok: true, summary: `scene: ${label}` })),
  duration: 100, trimBefore, screenshots: [], startedAt: "", finishedAt: "", ok: true,
  quality: { preset: "p", width: 1, height: 1, scale: 1, fps: 30 },
} as unknown as Take);

test("a scene's place in the finished video is the raw time less the trimmed setup", () => {
  const t = take([["a", 5], ["b", 12], ["c", 20]]);
  assert.deepEqual(sceneAt(t, "a"), { start: 2, hold: 7 });
  assert.deepEqual(sceneAt(t, "b"), { start: 9, hold: 8 });
  assert.equal(sceneAt(t, "nope"), null);
});

test("the last scene has no next scene, and does not produce a negative window", () => {
  const t = take([["a", 5], ["last", 40]]);
  const at = sceneAt(t, "last")!;
  assert.equal(at.start, 37);
  assert.ok(at.hold > 0);
});

test("a scene before the trim point clamps to the start rather than going negative", () => {
  const t = take([["early", 1]], 3);
  assert.equal(sceneAt(t, "early")!.start, 0);
});
