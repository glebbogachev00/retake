/** Product intent, and evidence tags — the two things that separate a finding
    somebody can act on from a technically correct guess. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NO_INTENT_NOTE, TEMPLATE, filled, intentBlock, intentPath, readIntent, writeIntent } from "../src/ext/intent.js";
import { EVIDENCE_ORDER, EVIDENCE_WORDS, legend, strongestFirst, tag } from "../src/ext/evidence.js";

const demos = () => fs.mkdtempSync(path.join(os.tmpdir(), "intent-"));

test("no note means no block — and the checks say so rather than pretending", () => {
  const d = demos();
  assert.equal(readIntent(d), null);
  assert.equal(intentBlock(d), "");
  assert.match(NO_INTENT_NOTE, /generic web page/);
});

test("the unfilled starter counts as nothing", () => {
  // Handing a judge headings and HTML comments as "what this product is" is
  // worse than handing it nothing: it looks like context and contains none.
  const d = demos();
  writeIntent(d, TEMPLATE);
  assert.equal(filled(TEMPLATE), false);
  assert.equal(readIntent(d), null);
  assert.equal(intentBlock(d), "");
});

test("a real note is read, and reaches the judge as context rather than instruction", () => {
  const d = demos();
  writeIntent(d, "# What this is\n\nA charter desk console. Faint internal notes are deliberate.");
  const block = intentBlock(d);
  assert.match(block, /charter desk console/);
  assert.match(block, /does not tell you what to conclude/);
  assert.match(block, /plainly broken is still broken/);
});

test("a demo's own note wins over the workspace one", () => {
  // One workspace here holds three different products. A single note would be
  // wrong for two of them every time it was read.
  const d = demos();
  writeIntent(d, "the whole workspace");
  writeIntent(d, "just this app", "avex");
  assert.match(readIntent(d, "avex") ?? "", /just this app/);
  assert.match(readIntent(d, "other") ?? "", /the whole workspace/);
  assert.equal(readIntent(d), "the whole workspace");
  assert.match(intentPath(d, "avex"), /avex\.product\.md$/);
});

test("every evidence kind has words a person can read, in order of strength", () => {
  assert.equal(EVIDENCE_ORDER[0], "reproduced", "the strongest is the one that was performed");
  assert.equal(EVIDENCE_ORDER[EVIDENCE_ORDER.length - 1], "unverified");
  for (const e of EVIDENCE_ORDER) assert.ok(EVIDENCE_WORDS[e]?.length > 8, `${e} needs plain words`);
});

test("findings sort strongest-evidence first", () => {
  const xs = [
    { id: "guess", evidence: "unverified" as const },
    { id: "watched", evidence: "reproduced" as const },
    { id: "read", evidence: "source-only" as const },
    { id: "frame", evidence: "seen-in-a-frame" as const },
  ];
  assert.deepEqual(strongestFirst(xs).map((x) => x.id), ["watched", "frame", "read", "guess"]);
});

test("the legend explains only the tags actually used", () => {
  const l = legend(["seen-in-a-frame", "unverified"]);
  assert.match(l, /seen-in-a-frame/);
  assert.doesNotMatch(l, /reproduced/);
  assert.equal(legend([]), "");
  assert.equal(tag("reproduced"), "[reproduced]");
});

test("each check declares which kind of evidence it produces", async () => {
  const { SWEEP_EVIDENCE } = await import("../src/ext/sweep.js");
  const { SENSE_EVIDENCE } = await import("../src/ext/sense.js");
  const { VERIFY_EVIDENCE } = await import("../src/ext/verify.js");
  const { DESTROY_EVIDENCE } = await import("../src/ext/destroy.js");
  assert.equal(SWEEP_EVIDENCE, "seen-in-a-frame");
  assert.equal(VERIFY_EVIDENCE, "seen-in-a-frame");
  assert.equal(SENSE_EVIDENCE, "read-from-the-run");
  assert.equal(DESTROY_EVIDENCE, "reproduced", "destroy performs the flow, so what it reports it did");
});

test("a demo name cannot escape the demos folder", async () => {
  // Shipped in 0.12.0 and found by review: `--demo ../../escaped` wrote its
  // file outside demos/ entirely. Path traversal, in the one tool that had
  // just been through a security pass.
  const { safeDemo } = await import("../src/ext/intent.js");
  const d = demos();
  for (const bad of ["../../escaped", "../x", "a/b", "/etc/passwd", "..", "Name", "a b", "a.b", "-lead"]) {
    assert.throws(() => writeIntent(d, "owned", bad), /not a demo name|refusing to write/, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(safeDemo("avex-usecases"), "avex-usecases");
  assert.equal(safeDemo("one-thought"), "one-thought");
  // Nothing was created anywhere.
  assert.deepEqual(fs.readdirSync(d), []);
  // An empty name is not an attack, it is "no demo" — pinned so the leniency
  // is a decision rather than an accident.
  assert.match(writeIntent(d, "workspace note", ""), /product\.md$/);
  assert.deepEqual(fs.readdirSync(d), ["product.md"]);
});

test("reading with a bad name is simply no note, not a crash", () => {
  // Only writing refuses. A read that throws would take a check down with it.
  const d = demos();
  assert.equal(readIntent(d, "../../etc/passwd"), null);
  assert.equal(intentBlock(d, "../../etc/passwd"), "");
});
