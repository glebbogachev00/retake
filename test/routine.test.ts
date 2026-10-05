/** The routine is the settings nobody should be asked about twice. These are
    the promises that make that true: it stamps, it does not invent narration,
    it leaves the story alone, and running it twice changes nothing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { loadManifest, resolve, warnings } from "../src/manifest.js";
import { RoutineSchema, STYLES, applyToManifest, compare, learnFrom, pick, readRoutines, starter, voiceId, writeRoutines } from "../src/routine.js";

function workspace(manifest: string): { dir: string; demos: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-routine-"));
  const demos = path.join(dir, "demos");
  fs.mkdirSync(demos, { recursive: true });
  const file = path.join(demos, "x.yaml");
  fs.writeFileSync(file, manifest);
  return { dir, demos, file };
}

const DRIFTED = `name: x
url: http://localhost:3000
preset: post-square          # whatever the model felt like
viewport: { width: 1440, height: 1080 }
scale: 1.8
captions: false
steps:
  - { action: scene, label: start, caption: "An empty workspace." }
  - { action: wait, ms: 1500 }
`;

test("the stamp fixes format and drops the pin that beats it", () => {
  const { file } = workspace(DRIFTED);
  const r = RoutineSchema.parse({ style: "showcase", captions: true });
  const { changed } = applyToManifest(file, r);

  const m = loadManifest(file).manifest;
  assert.equal(m.preset, STYLES.showcase.preset);
  assert.equal(m.layout, STYLES.showcase.layout, "showcase is the inset card — the look every shipped Capture demo has");
  assert.equal(m.scale, STYLES.showcase.scale);
  assert.equal(m.captions, true);
  assert.equal(m.viewport, undefined, "a pinned viewport silently beats the preset — the one way two takes come out different shapes");
  assert.ok(changed.some((c) => c.startsWith("viewport")));
  // and the story is untouched
  assert.equal(m.steps.length, 2);
  assert.equal(m.url, "http://localhost:3000");
});

test("every style resolves to a real canvas", () => {
  for (const [name, style] of Object.entries(STYLES)) {
    const { file } = workspace(DRIFTED);
    applyToManifest(file, RoutineSchema.parse({ style: name }));
    const q = resolve(loadManifest(file).manifest);
    assert.ok(q.width > 0 && q.height > 0, `${name} has no canvas`);
    assert.equal(q.name, style.preset);
  }
});

test("a second apply changes nothing", () => {
  const { file } = workspace(DRIFTED);
  const r = RoutineSchema.parse({ style: "mobile", voice: "andrew", rate: -8 });
  applyToManifest(file, r);
  const after = fs.readFileSync(file, "utf8");
  const second = applyToManifest(file, r);
  assert.deepEqual(second.changed, []);
  assert.equal(fs.readFileSync(file, "utf8"), after);
});

test("a routine never turns narration on by itself", () => {
  const { file } = workspace(DRIFTED);
  const { skipped } = applyToManifest(file, RoutineSchema.parse({ voice: "andrew" }));
  assert.equal(loadManifest(file).manifest.voiceover, false, "narration needs a script and a person who heard it — not a setting");
  assert.ok(skipped.some((s) => s.includes("none written")));
});

test("narration that exists gets the locked voice and rate, and loses the comment that now lies", () => {
  const { file } = workspace(`name: x
url: http://localhost:3000
voiceover:
  voice: en-US-GuyNeural
  ratePercent: 25            # too fast
  script: "One line."
  approved: true
steps:
  - { action: scene, label: start, caption: "Hi." }
`);
  applyToManifest(file, RoutineSchema.parse({ voice: "andrew", rate: -8 }));
  const vo = loadManifest(file).manifest.voiceover as { voice: string; ratePercent: number; script?: string; approved: boolean };
  assert.equal(vo.voice, voiceId("andrew"));
  assert.equal(vo.ratePercent, -8);
  assert.equal(vo.script, "One line.", "the script is the writer's, not the routine's");
  assert.equal(vo.approved, true);
  assert.ok(!fs.readFileSync(file, "utf8").includes("too fast"), "a comment about the old value is a lie once the routine corrects it");
});

test("silent means silent, and music makes it a launch cut", () => {
  const silent = workspace(DRIFTED);
  applyToManifest(silent.file, RoutineSchema.parse({ voice: "silent" }));
  assert.equal(loadManifest(silent.file).manifest.voiceover, false);

  const scored = workspace(DRIFTED);
  applyToManifest(scored.file, RoutineSchema.parse({ music: "bed.mp3" }));
  const m = loadManifest(scored.file).manifest;
  assert.equal(typeof m.music === "string" ? m.music : m.music?.file, "bed.mp3");
  assert.equal(m.mode, "launch", "`mode: demo` warns about music — the stamp settles it instead of leaving a warning");
});

test("comments elsewhere in the manifest survive", () => {
  const { file } = workspace(`# why this demo exists
name: x
url: http://localhost:3000
steps:
  # the payoff
  - { action: scene, label: start, caption: "Hi." }
`);
  applyToManifest(file, RoutineSchema.parse({}));
  const out = fs.readFileSync(file, "utf8");
  assert.ok(out.includes("# why this demo exists"));
  assert.ok(out.includes("# the payoff"));
});

test("settings land with the settings, not after the steps", () => {
  const { file } = workspace(DRIFTED);
  applyToManifest(file, RoutineSchema.parse({}));
  const keys = (YAML.parseDocument(fs.readFileSync(file, "utf8")).contents as YAML.YAMLMap).items
    .map((i) => (YAML.isScalar(i.key) ? String(i.key.value) : String(i.key)));
  assert.ok(keys.indexOf("layout") < keys.indexOf("steps"), `steps should come last: ${keys.join(", ")}`);
});

test("the file round-trips, and a missing routine says what to do", () => {
  const { demos } = workspace(DRIFTED);
  assert.equal(readRoutines(demos), null);
  assert.throws(() => pick(demos), /retake routine init/);

  const data = starter();
  data.routines["techtutor-vn"] = RoutineSchema.parse({ voice: "vi-VN-HoaiMyNeural", style: "mobile" });
  data.use = "techtutor-vn";
  writeRoutines(demos, data);

  const back = pick(demos);
  assert.equal(back.name, "techtutor-vn");
  assert.equal(voiceId(back.routine.voice), "vi-VN-HoaiMyNeural", "an unnamed voice id passes through — that is how a routine speaks another language");
  assert.equal(pick(demos, "default").routine.voice, "silent");
  assert.throws(() => pick(demos, "nope"), /no routine called/);
});

test("the rate is bounded where the manifest bounds it", () => {
  assert.ok(!RoutineSchema.safeParse({ rate: 95 }).success);
  assert.ok(!RoutineSchema.safeParse({ style: "cinematic" }).success);
  assert.ok(RoutineSchema.safeParse({ rate: -30 }).success);
});


test("a routine is read off work that already exists, not off Retake's defaults", () => {
  // The bug this exists for: the first routine a workspace got was Retake's
  // opinion wearing the clothes of a standard, and `apply` then stamped it
  // over everything with confidence. Derive it from the manifests instead.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-learn-"));
  const house = (name: string, extra = "") => {
    const f = path.join(dir, `${name}.yaml`);
    fs.writeFileSync(f, `name: ${name}
url: http://localhost:3000
preset: post-landscape
layout: card
scale: 1.7
captions: false
typing: brisk
theme: { background: "#2f5d3f", ink: "#f7f4ea" }
${extra}steps:
  - { action: scene, label: a, caption: "Hi." }
`);
    return f;
  };
  const files = [house("one"), house("two"), house("three", 'voiceover: { voice: en-GB-RyanNeural, ratePercent: 0, approved: true, script: "x" }\n')];

  const { routine, from, notes } = learnFrom(files);
  assert.equal(from.length, 3);
  assert.equal(routine.style, "showcase");
  assert.equal(routine.captions, false, "captions off is what the work says, whatever Retake's default is");
  assert.equal(routine.typing, "brisk");
  assert.deepEqual(routine.theme, { background: "#2f5d3f", ink: "#f7f4ea" });
  // Two of three are silent, so silent wins — and the split is reported
  // rather than quietly resolved.
  assert.equal(routine.voice, "silent");
  assert.ok(notes.some((n) => n.startsWith("voice:")), `a disagreement must be said out loud: ${notes.join(" | ")}`);

  assert.throws(() => learnFrom([]), /nothing to learn from/);
});

test("a learned voice comes back by name when Retake knows it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-learn2-"));
  const f = path.join(dir, "x.yaml");
  fs.writeFileSync(f, `name: x
url: http://localhost:3000
preset: post-landscape
layout: card
voiceover: { voice: en-GB-RyanNeural, ratePercent: -5, approved: true, script: "x" }
steps:
  - { action: scene, label: a, caption: "Hi." }
`);
  const { routine } = learnFrom([f]);
  assert.equal(routine.voice, "ryan", "an id Retake has a name for comes back as the name");
  assert.equal(routine.rate, -5);
});

test("a key Retake does not know fails instead of being dropped", () => {
  // `{ action: scroll, selector: "…" }` — the key is `to:` — validated, dry-ran
  // green, and scrolled to the origin on every take. Four takes before anyone
  // looked at a frame. Green and wrong is the worst thing a checker can be.
  const { file } = workspace(`name: x
url: http://localhost:3000
steps:
  - { action: scroll, selector: "h4", pauseAfter: 100 }
`);
  assert.throws(() => loadManifest(file), /Unrecognized key.*selector/s);

  const ok = workspace(`name: x
url: http://localhost:3000
steps:
  - { action: scroll, to: "h4", align: center }
`);
  assert.doesNotThrow(() => loadManifest(ok.file));
});

test("a script copied from another demo is caught before it is recorded", () => {
  // The failure nothing else sees: right size, right voice, right loudness,
  // every check green, and the wrong words over the wrong screens.
  const wrong = workspace(`name: x
url: http://localhost:3000
voiceover:
  voice: en-US-AndrewNeural
  approved: true
  script: "A goal is something you have not done yet. An intention is written as already true."
steps:
  - { action: click, selector: "button.tab" }
  - { action: scene, label: a, caption: "Some of what you say is a thing to do." }
  - { action: click, selector: "button.other" }
  - { action: scene, label: b, caption: "Some of it is a question you keep living with." }
`);
  assert.ok(
    warnings(loadManifest(wrong.file).manifest).some((w) => /narration barely mentions/.test(w)),
    "a script about intentions over a demo about actions must be flagged",
  );

  const right = workspace(`name: x
url: http://localhost:3000
voiceover:
  voice: en-US-AndrewNeural
  approved: true
  script: "Some of what you say is a thing to do. Some of it is a question you keep living with."
steps:
  - { action: click, selector: "button.tab" }
  - { action: scene, label: a, caption: "Some of what you say is a thing to do." }
  - { action: click, selector: "button.other" }
  - { action: scene, label: b, caption: "Some of it is a question you keep living with." }
`);
  assert.deepEqual(warnings(loadManifest(right.file).manifest).filter((w) => /narration/.test(w)), []);
});

test("two videos that agree with each other can still both be wrong", () => {
  // A batch whose final render failed leaves two preview-quality files that
  // match perfectly — at the wrong frame rate. Judging them only against each
  // other calls that a pass.
  const r = RoutineSchema.parse({ style: "showcase" });
  const previewPair = [
    { name: "a", width: 1920, height: 1080, fps: 24, seconds: 30, hasAudio: false, lufs: null },
    { name: "b", width: 1920, height: 1080, fps: 24, seconds: 15, hasAudio: false, lufs: null },
  ];
  assert.deepEqual(compare(previewPair, r).problems, [], "they do agree with each other");
  const vsStandard = compare(previewPair, r, { width: 1920, height: 1080, fps: 30 });
  assert.equal(vsStandard.problems.length, 2);
  assert.ok(vsStandard.problems.every((p) => /24fps, but showcase is 30fps/.test(p)));
});

test("loudness drift between videos is a problem a viewer feels", () => {
  const r = RoutineSchema.parse({ style: "showcase", voice: "andrew" });
  const { problems } = compare([
    { name: "a", width: 1920, height: 1080, fps: 30, seconds: 30, hasAudio: true, lufs: -19.8 },
    { name: "b", width: 1920, height: 1080, fps: 30, seconds: 15, hasAudio: true, lufs: -14.1 },
  ], r);
  assert.ok(problems.some((p) => /loudness spread/.test(p)), problems.join(" | "));
});
