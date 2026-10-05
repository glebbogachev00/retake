/** Reproducing a north-star video. Every piece here was a miss a person found
    by watching: the spacing, the card, the narration landing nowhere in
    particular, and no way for Retake to say any of it was wrong. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pageGeometry, GEOMETRY_VERSION } from "../src/record.js";
import { cuesPerParagraph } from "../src/voice.js";
import { loadManifest } from "../src/manifest.js";
import { RoutineSchema, preflightAgainst } from "../src/routine.js";

test("page scale is a real device pixel ratio, not CSS zoom", () => {
  // Zoom left the page with two units: CSS lengths in one, everything it
  // measures in the other. An app that measured a box and wrote the number
  // back came out 1.7× too tall. A real DPR has one unit.
  const g = pageGeometry({ viewport: { width: 1920, height: 1080 }, scale: 1.7 });
  assert.deepEqual(g.args, ["--force-device-scale-factor=1.7"], "Playwright's own deviceScaleFactor does not reach the video; the browser flag does");
  assert.deepEqual(g.viewport, { width: 1129, height: 635 }, "the app lays out at canvas÷scale");
  assert.equal(g.deviceScaleFactor, 1.7, "and the context must agree, or Playwright emulates DPR 1 over the flag");
  assert.deepEqual(g.video, { width: 1920, height: 1080 }, "the video is the full canvas");

  const flat = pageGeometry({ viewport: { width: 1920, height: 930 }, scale: 1 });
  assert.deepEqual(flat.args, [], "scale 1 changes nothing");
  assert.deepEqual(flat.viewport, { width: 1920, height: 930 });
  assert.ok(GEOMETRY_VERSION, "a take recorded under zoom must never be reused as native");
});

test("one performance is cut into its paragraphs at the sentence timings", () => {
  const paragraphs = ["Under Personalize there is a switch. Turn it on.", "Then pin one.", "And there it is."];
  const cues = [
    { start: 0.05, end: 2.1, text: "Under Personalize there is a switch." },
    { start: 2.1, end: 3.0, text: "Turn it on." },
    { start: 3.4, end: 4.6, text: "Then pin one." },
    { start: 5.0, end: 6.2, text: "And there it is." },
  ];
  assert.deepEqual(cuesPerParagraph(paragraphs, cues), [
    { start: 0.05, end: 3.0 },   // two sentences, one paragraph
    { start: 3.4, end: 4.6 },
    { start: 5.0, end: 6.2 },
  ]);
});

function manifest(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-ns-"));
  const f = path.join(dir, "x.yaml");
  fs.writeFileSync(f, body);
  return f;
}

test("aligned narration needs one paragraph per narrated scene — said before recording", () => {
  const base = (script: string) => `name: x
url: http://localhost:3000
voiceover:
  voice: en-US-AndrewNeural
  approved: true
  align: scenes
  script: |
${script.split("\n").map((l) => "    " + l).join("\n")}
steps:
  - { action: click, selector: "#a" }
  - { action: scene, label: one, caption: "First." }
  - { action: click, selector: "#b" }
  - { action: scene, label: two, caption: "Second." }
`;
  assert.throws(() => loadManifest(manifest(base("Only one paragraph here."))), /one paragraph per narrated scene/);
  assert.doesNotThrow(() => loadManifest(manifest(base("The first line.\n\nThe second line."))));
});

test("a branded card is declared, not improvised", () => {
  const f = manifest(`name: x
url: http://localhost:3000
card: { background: "#fdfdfd", ink: "#2f5d3f", logo: brand/mark.svg, font: brand/f.woff2, ornament: circles, orb: "#eff6f2" }
steps:
  - { action: scene, label: a, caption: "A." }
`);
  const card = loadManifest(f).manifest.card!;
  assert.equal(card.ornament, "circles");
  assert.equal(card.weight, 560, "a sensible default weight");
  assert.throws(() => loadManifest(manifest(`name: x
url: http://localhost:3000
card: { background: "#fff", ink: "#000", shadow: true }
steps:
  - { action: scene, label: a, caption: "A." }
`)), /Unrecognized key/, "a card key Retake does not draw is a mistake");
});

test("before recording, the routine says what it cannot reproduce", () => {
  const ref = { width: 1920, height: 1080, fps: 30, seconds: 48, hasAudio: true, lufs: -21 };
  const silent = preflightAgainst(ref, RoutineSchema.parse({ style: "showcase", voice: "silent" }));
  assert.ok(silent.some((g) => /narrated, the routine is silent/.test(g)));
  assert.ok(silent.some((g) => /no title or end card/.test(g)));

  const plainCards = preflightAgainst(ref, RoutineSchema.parse({ style: "showcase", voice: "andrew", cards: true }));
  assert.ok(plainCards.some((g) => /Retake's own card/.test(g)), "a routine with cards but no brand will not reproduce a branded card");

  const right = preflightAgainst(ref, RoutineSchema.parse({ style: "showcase", voice: "andrew", cards: true, card: { background: "#fdfdfd", ink: "#2f5d3f" } }));
  assert.deepEqual(right, []);

  const vertical = preflightAgainst(ref, RoutineSchema.parse({ style: "mobile", voice: "andrew", cards: true, card: { background: "#fff", ink: "#000" } }));
  assert.ok(vertical.some((g) => /size/.test(g)));
});

test("lines are cut in the middle of the pause, never at the sentence boundary", async () => {
  const { cutPoints } = await import("../src/voice.js");
  // Sentence timing says line 2 starts at 3.0, but the speech before it ends
  // at 2.9 and the breath runs to 3.3. Cutting at 3.0 ± margin clipped words.
  const quiet = [{ start: 0, end: 0.05 }, { start: 2.9, end: 3.3 }, { start: 5.0, end: 5.6 }];
  const got = cutPoints([3.0, 5.4], quiet, 7);
  assert.ok(Math.abs(got[0] - 3.1) < 1e-9 && Math.abs(got[1] - 5.3) < 1e-9, `cut in the middle of each pause: ${got}`);
  // No pause nearby: fall back to the boundary rather than inventing one.
  assert.deepEqual(cutPoints([1.5], quiet, 7), [1.5]);
});

test("a narrated demo whose first line comes after its actions is flagged", async () => {
  const { warnings } = await import("../src/manifest.js");
  const after = loadManifest(manifest(`name: x
url: http://localhost:3000
voiceover: { voice: en-US-AndrewNeural, approved: true, align: scenes, script: "Turn it on." }
steps:
  - { action: click, selector: "#switch" }
  - { action: scene, label: on, caption: "Turn it on." }
`)).manifest;
  assert.ok(warnings(after).some((w) => /before the first line is spoken/.test(w)), "the voice would say 'turn it on' after it is on");

  const leads = loadManifest(manifest(`name: x
url: http://localhost:3000
voiceover: { voice: en-US-AndrewNeural, approved: true, align: scenes, script: "Turn it on." }
steps:
  - { action: scene, label: on, caption: "Turn it on." }
  - { action: click, selector: "#switch" }
`)).manifest;
  assert.ok(!warnings(leads).some((w) => /before the first line is spoken/.test(w)));
});
