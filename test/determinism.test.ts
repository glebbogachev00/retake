import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Manifest } from "../src/manifest.js";
import { captureHash, determinismScript, persistentCssScript } from "../src/record.js";

function runDeterminism(seed: number, freezeTime = "2026-09-18T09:00:00Z") {
  const sandbox = { Date, Math: Object.create(Math), globalThis: null as unknown };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(determinismScript({ freezeTime, randomSeed: seed }), sandbox);
  const DateCtor = sandbox.Date as unknown as DateConstructor;
  const math = sandbox.Math as Math;
  return {
    now: DateCtor.now(),
    date: new DateCtor().toISOString(),
    values: [math.random(), math.random(), math.random()],
  };
}

test("frozen time and random seed reproduce the same browser values", () => {
  const first = runDeterminism(42);
  const second = runDeterminism(42);
  assert.deepEqual(first, second);
  assert.equal(first.date, "2026-09-18T09:00:00.000Z");
});

test("a different random seed produces a different sequence", () => {
  assert.notDeepEqual(runDeterminism(42).values, runDeterminism(43).values);
});

test("malformed freeze time fails manifest validation", () => {
  const parsed = Manifest.safeParse({
    name: "x",
    url: "http://localhost:3000",
    determinism: { freezeTime: "tomorrow morning", randomSeed: 42 },
    steps: [{ action: "wait", ms: 10 }],
  });
  assert.equal(parsed.success, false);
});

test("capture fingerprint changes when a referenced fixture changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-fingerprint-"));
  fs.writeFileSync(path.join(dir, "seed.json"), "{\"value\":1}");
  const manifest = Manifest.parse({
    name: "x",
    url: "http://localhost:3000",
    seed: [{ kind: "evaluate", script: "window.x = window.__seed", from: "seed.json" }],
    steps: [{ action: "wait", ms: 10 }],
  });
  const before = captureHash(manifest, dir);
  fs.writeFileSync(path.join(dir, "seed.json"), "{\"value\":2}");
  assert.notEqual(captureHash(manifest, dir), before);
});

test("capture fingerprint changes when an uploaded file changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-upload-fingerprint-"));
  fs.writeFileSync(path.join(dir, "sample.txt"), "one");
  const manifest = Manifest.parse({
    name: "x",
    url: "http://localhost:3000",
    steps: [{ action: "upload", selector: "input[type=file]", files: "sample.txt" }],
  });
  const before = captureHash(manifest, dir);
  fs.writeFileSync(path.join(dir, "sample.txt"), "two");
  assert.notEqual(captureHash(manifest, dir), before);
});

test("persistent privacy CSS is capture-relevant and installed before each document", () => {
  const base = {
    name: "x",
    url: "http://localhost:3000",
    steps: [{ action: "wait" as const, ms: 10 }],
  };
  const first = Manifest.parse({ ...base, persistentCss: ".private { display: none !important; }" });
  const second = Manifest.parse({ ...base, persistentCss: ".private, .chat { display: none !important; }" });
  assert.notEqual(captureHash(first), captureHash(second));
  assert.equal(first.persistentCss, ".private { display: none !important; }");
  const script = persistentCssScript(first.persistentCss!);
  assert.match(script, /retake-persistent-css/);
  assert.match(script, /MutationObserver/);
  assert.match(script, /\.private/);
});
