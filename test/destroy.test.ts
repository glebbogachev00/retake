/** destroy: the generator, its refusals, and the promise that it can never
    reach an existing take. Nothing here drives a browser — the shapes are
    manifest-to-manifest, which is exactly what makes them testable. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { SHAPES, planDestroy, refuseToRun, sandbox, readTake } from "../src/ext/destroy.js";
import type { Manifest } from "../src/manifest.js";

const base = {
  name: "checkout",
  url: "http://localhost:3109",
  seed: [{ kind: "command", run: "node seed.mjs" }],
  stub: [{ url: "**/api/quote", status: 200, json: { price: 1 } }],
  steps: [
    { action: "scene", label: "form" },
    { action: "type", selector: "#name", text: "Nguyen Minh Anh" },
    { action: "click", selector: "button.buy" },
    { action: "waitFor", selector: ".done" },
    { action: "scene", label: "done" },
  ],
} as unknown as Manifest;

const shape = (n: string) => SHAPES.find((s) => s.name === n)!;
const out = () => fs.mkdtempSync(path.join(os.tmpdir(), "destroy-"));

test("double-submit presses the committing click twice, and only that one", () => {
  const m = shape("double-submit").apply(base)!;
  const clicks = (m.steps as unknown as { action: string; selector?: string }[]).filter((s) => s.action === "click");
  assert.equal(clicks.length, 2);
  assert.equal(clicks[0].selector, "button.buy");
  assert.equal(clicks[1].selector, "button.buy");
});

test("reload-midway reloads after the commit, not before it", () => {
  const s = (shape("reload-midway").apply(base)!.steps as unknown as { action: string; script?: string }[]);
  const reload = s.findIndex((x) => x.script === "location.reload()");
  const click = s.findIndex((x) => x.action === "click");
  assert.ok(reload > click, "the reload must land after the thing it interrupts");
});

test("provider-down turns every stub into a 500, and provider-empty into an empty 200", () => {
  const down = shape("provider-down").apply(base)!;
  assert.deepEqual(down.stub.map((s) => s.status), [500]);
  const empty = shape("provider-empty").apply(base)!;
  assert.deepEqual(empty.stub.map((s) => s.status), [200]);
  assert.deepEqual(empty.stub[0].json, []);
});

test("a shape with nothing to work with returns null instead of a useless candidate", () => {
  const noStubs = { ...base, stub: [] } as unknown as Manifest;
  assert.equal(shape("provider-down").apply(noStubs), null);
  const noSeed = { ...base, seed: [] } as unknown as Manifest;
  assert.equal(shape("empty-state").apply(noSeed), null);
  const noTyping = { ...base, steps: base.steps.filter((s) => s.action !== "type") } as unknown as Manifest;
  assert.equal(shape("long-input").apply(noTyping), null);
});

test("the original manifest is never mutated", () => {
  const before = JSON.stringify(base);
  for (const s of SHAPES) s.apply(base);
  assert.equal(JSON.stringify(base), before);
});

test("every candidate is a real, readable manifest with its own name", () => {
  const root = out();
  const plan = planDestroy(base, root);
  assert.ok(plan.candidates.length >= 7);
  for (const c of plan.candidates) {
    const doc = YAML.parse(fs.readFileSync(c.file, "utf8").replace(/^#.*$/gm, "")) as Manifest;
    assert.equal(doc.name, `checkout-${c.shape.name}`);
    assert.notEqual(doc.name, base.name, "a candidate must never be able to overwrite the demo it came from");
    assert.ok(doc.steps.length > 0);
  }
});

test("everything lands under .destroy/<demo>/ — an existing take is unreachable from here", () => {
  const root = out();
  fs.mkdirSync(path.join(root, "checkout"), { recursive: true });
  fs.writeFileSync(path.join(root, "checkout", "take.json"), "PRECIOUS");
  const plan = planDestroy(base, root);
  assert.equal(plan.root, sandbox(root, "checkout"));
  for (const c of plan.candidates) assert.ok(c.file.startsWith(path.join(root, ".destroy") + path.sep), c.file);
  assert.equal(fs.readFileSync(path.join(root, "checkout", "take.json"), "utf8"), "PRECIOUS");
});

test("a shape nobody has heard of is refused by name, not silently ignored", () => {
  const plan = planDestroy(base, out(), { only: ["nonsense"] });
  assert.match(plan.refused!, /no such shape: nonsense/);
  assert.equal(plan.candidates.length, 0);
});

test("skipped shapes are reported with the reason, never dropped", () => {
  const plan = planDestroy({ ...base, stub: [] } as unknown as Manifest, out());
  const names = plan.skipped.map((s) => s.name);
  assert.ok(names.includes("provider-down"));
  assert.match(plan.skipped.find((s) => s.name === "provider-down")!.why, /stubs nothing/);
});

test("it will not run against an app it did not start", () => {
  const remote = { ...base, url: "https://useretake.app" } as unknown as Manifest;
  assert.match(refuseToRun(remote, {})!, /is not local/);
  assert.equal(refuseToRun(remote, { RETAKE_DESTROY_REMOTE: "1" }), null);
});

test("it will not run a demo whose state is not reproducible", () => {
  const loose = { ...base, seed: [], stub: [] } as unknown as Manifest;
  assert.match(refuseToRun(loose, {})!, /neither seeds its state nor stubs/);
  assert.equal(refuseToRun(loose, { RETAKE_DESTROY_UNSEEDED: "1" }), null);
});

test("stubbing counts as taking control of the state, the same as seeding", () => {
  // The Avex demos stub what they read instead of seeding a database. That is
  // the author having decided what the app sees, which is the thing the rule
  // is actually about.
  assert.equal(refuseToRun({ ...base, seed: [] } as unknown as Manifest, {}), null);
  assert.equal(refuseToRun({ ...base, stub: [] } as unknown as Manifest, {}), null);
});

test("local and seeded is allowed", () => {
  assert.equal(refuseToRun(base, {}), null);
});

test("reading a take: a failed step and an app error are findings, a --from fragment is not", () => {
  const t = {
    timeline: [{ index: 2, action: "click", summary: "click .buy", ok: false, error: "timeout" }],
    pageErrors: [{ at: 4, text: "TypeError: total is undefined" }],
    partial: 'recorded from scene "x" (from) — a fragment for iteration, not a finished cut',
  } as never;
  const why = readTake(t);
  assert.equal(why.length, 2);
  assert.match(why[0], /step 2/);
  assert.match(why[1], /total is undefined/);
});

test("a failed second press is the app WINNING, not a bug", () => {
  // The first version of this reported it as a finding. On the real Avex app
  // that produced one false alarm out of eight, on the most valuable shape
  // there is — which is how a tool like this gets ignored.
  const s = shape("double-submit");
  assert.equal(s.read(true, []).verdict, "held");
  assert.match(s.read(true, []).note, /refusing to do it twice/);
  assert.equal(s.read(false, []).verdict, "look");
});

test("refusing to be clicked before it is ready is also the app winning", () => {
  assert.equal(shape("impatient").read(true, []).verdict, "held");
  assert.equal(shape("impatient").read(false, []).verdict, "look");
});

test("the ambiguous ones say `look` rather than guessing", () => {
  // A flow that stops when its provider is down might be a handled error
  // screen or a dead end. Calling either one costs more than asking.
  for (const n of ["provider-down", "provider-empty", "empty-state"]) {
    assert.equal(shape(n).read(true, []).verdict, "look", n);
  }
  for (const n of ["long-input", "awkward-input"]) {
    assert.equal(shape(n).read(false, []).verdict, "look", `${n} passing cleanly still needs eyes on the picture`);
  }
});

test("the plainly bad ones still say broke", () => {
  assert.equal(shape("reload-midway").read(true, []).verdict, "broke");
  assert.equal(shape("back-button").read(true, []).verdict, "broke");
  assert.equal(shape("reload-midway").read(false, []).verdict, "held");
});

test("every shape has a reader — a new one cannot be added without deciding what its failure means", () => {
  for (const s of SHAPES) assert.equal(typeof s.read, "function", s.name);
});

test("it will not abuse an app somebody else is filming", () => {
  // This is here because it happened: destroy ran against a live app on :3200
  // while another agent was eight minutes into recording the same app.
  const root = out();
  const other = path.join(root, "someone-elses-demo");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, ".retake-lock"), "1");
  fs.writeFileSync(path.join(other, "manifest.used.yaml"), YAML.stringify({ url: "http://localhost:3109/somewhere" }));

  const no = refuseToRun(base, {}, root);
  assert.match(no!, /recording "someone-elses-demo"/);
  assert.equal(refuseToRun(base, { RETAKE_DESTROY_ANYWAY: "1" }, root), null, "an override must exist for a dead lock");

  // A different app is not a conflict.
  fs.writeFileSync(path.join(other, "manifest.used.yaml"), YAML.stringify({ url: "http://localhost:9999/" }));
  assert.equal(refuseToRun(base, {}, root), null);

  // Neither is a stale one.
  fs.writeFileSync(path.join(other, "manifest.used.yaml"), YAML.stringify({ url: "http://localhost:3109/" }));
  const old = (Date.now() - 60 * 60_000) / 1000;
  fs.utimesSync(path.join(other, ".retake-lock"), old, old);
  assert.equal(refuseToRun(base, {}, root), null);
});
