/** Recording a demo is the whole core product. verify, sweep, sense, destroy
    and fixed are optional services run against a take that already exists.
    Nothing in the product may say or imply otherwise — an extension that
    redefines when the core's own output is finished has stopped being an
    extension. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

/** Phrasings that make an optional check sound like part of the recording. */
const IMPLIES_REQUIRED = [
  /not finished until/i,
  /is not (?:a )?(?:complete|finished)\b[^.]*\b(?:verify|sweep|sense)\b/i,
  /before a demo is called finished/i,
  /a recording nobody has looked at is a recording, not a result/i,
];

const SURFACES = ["AGENTS.md", "README.md", "skill/SKILL.md", "src/ext/notes.ts", "src/ext/sweep.ts", "src/ext/verify.ts", "src/ui/chat.html"];

test("nothing tells a person their recording is unfinished without an extension", () => {
  const guilty: string[] = [];
  for (const f of SURFACES) {
    const text = read(f);
    for (const re of IMPLIES_REQUIRED) {
      const hit = re.exec(text);
      if (hit) guilty.push(`${f}: “${hit[0].slice(0, 70)}”`);
    }
  }
  assert.deepEqual(guilty, [], `these imply a take is incomplete without an optional check:\n  ${guilty.join("\n  ")}`);
});

test("the core's own verdict consults no extension", async () => {
  // `check` is what says a take is sound. If it ever reads a check's receipt,
  // the recording has quietly acquired a dependency on an optional service.
  const render = read("src/render.ts");
  for (const name of ["verify(", "sweep(", "sense(", "readChecks", "checks.json"]) {
    assert.ok(!render.includes(name), `src/render.ts reaches for ${name}`);
  }
  const record = read("src/record.ts");
  for (const name of ["verify(", "sweep(", "sense(", "readChecks"]) {
    assert.ok(!record.includes(name), `src/record.ts reaches for ${name}`);
  }
});

test("the extensions describe themselves as advisory where they do not gate", async () => {
  // sweep and sense report; verify and fixed gate on questions a person wrote.
  // Nothing may claim a release verdict on its own.
  const sweep = read("src/ext/sweep.ts");
  assert.match(sweep, /things to look at, not verdicts/);
  const sense = read("src/ext/sense.ts");
  assert.match(sense, /not verdicts|It ASKS, it does not fail/);
});
