/** Many demos at once: the scheduling rules, without a browser. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultParallel, discover, pickNext, renderReport, runBatch, type BatchItem } from "../src/batch.js";

type Slot = Pick<BatchItem, "stage" | "name" | "lock">;

test("demos sharing a lock never run together; everything else does", () => {
  const items: Slot[] = [
    { name: "a", stage: "record", lock: "hub" },
    { name: "b", stage: "queued", lock: "hub" },
    { name: "c", stage: "queued" },
  ];
  assert.equal(pickNext(items), 2, "b waits for a's lock, c goes ahead");
  items[2].stage = "dry";
  assert.equal(pickNext(items), -1, "only b is left and its lock is held");
  items[0].stage = "done";
  assert.equal(pickNext(items), 1, "a finished — b may start");
});

test("a lock held during the dry run counts: dry seeds the same backend", () => {
  assert.equal(pickNext([{ name: "a", stage: "dry", lock: "hub" }, { name: "b", stage: "queued", lock: "hub" }]), -1);
});

test("two items recording into the same folder never overlap", () => {
  assert.equal(pickNext([{ name: "same", stage: "record" }, { name: "same", stage: "queued" }]), -1);
});

test("the default is about half the cores, never zero, never more than three", () => {
  assert.equal(defaultParallel(1), 1);
  assert.equal(defaultParallel(4), 2);
  assert.equal(defaultParallel(6), 3);
  assert.equal(defaultParallel(32), 3);
});

test("a bare batch means the manifests in demos/, not the files beside them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "batch-"));
  for (const f of ["b.yaml", "a.yml", "c.json", "a.flags.json", "style.md", ".hidden.yaml"]) fs.writeFileSync(path.join(dir, f), "");
  fs.mkdirSync(path.join(dir, "seeds"));
  assert.deepEqual(discover(dir).map((f) => path.basename(f)), ["a.yml", "b.yaml", "c.json"]);
  assert.deepEqual(discover(path.join(dir, "missing")), []);
});

test("invalid manifests and name clashes are reported without recording anything", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "batch-"));
  const demos = path.join(ws, "demos");
  fs.mkdirSync(demos);
  fs.writeFileSync(path.join(demos, "broken.yaml"), "name: Not Kebab\nurl: nope\nsteps: []\n");
  const one = "url: http://localhost:9/\nsteps:\n  - { action: wait }\n";
  fs.writeFileSync(path.join(demos, "x.yaml"), "name: twin\n" + one);
  fs.writeFileSync(path.join(demos, "y.yaml"), "name: twin\n" + one);
  // dryOnly with an unreachable app: the twin that is allowed to run fails
  // its dry run quickly; what matters here is what never got that far.
  const r = await runBatch({ files: discover(demos), outRoot: path.join(ws, "outputs"), parallel: 2, dryOnly: true });
  const by = Object.fromEntries(r.items.map((i) => [path.basename(i.file), i]));
  assert.equal(by["broken.yaml"].ok, false);
  assert.match(by["broken.yaml"].result ?? "", /Invalid manifest/);
  assert.equal(by["y.yaml"].ok, false);
  assert.match(by["y.yaml"].result ?? "", /same name as x\.yaml/);
  assert.ok(fs.existsSync(path.join(r.dir, "report.md")));
  assert.ok(fs.existsSync(path.join(r.dir, "report.json")));
  assert.ok(r.finishedAt);
});

test("the report says what is good, what is not, and why", () => {
  const md = renderReport({
    startedAt: "2026-10-03T10:00:00.000Z", finishedAt: "2026-10-03T10:01:00.000Z", parallel: 2, dir: "/w/outputs/.batch/x",
    items: [
      { file: "/w/demos/a.yaml", name: "a", stage: "done", ok: true, result: "12.0s video", seconds: 30, log: "/w/outputs/.batch/x/a.log", outDir: "/w/outputs/a" },
      { file: "/w/demos/b.yaml", name: "b", stage: "done", ok: false, result: "dry failed — click #x | timeout", seconds: 9, log: "/w/outputs/.batch/x/b.log", outDir: "/w/outputs/b" },
      { file: "/w/demos/c.yaml", name: "c", stage: "done", ok: true, result: "9.0s video", log: "/w/outputs/.batch/x/c.log", outDir: "/w/outputs/c",
        compare: { reference: "capture", verdicts: [{ ok: true, line: "length 9.0s" }, { ok: false, line: 'scene "end" holds 9.0s' }] } },
    ],
  });
  assert.match(md, /2 of 3 good · 2 at a time · 60s wall clock/);
  assert.match(md, /✗ dry failed — click #x \\\| timeout/); // a pipe in a cell is escaped
  assert.match(md, /## c[\s\S]*\*\*off\*\* — scene "end" holds 9\.0s/);
  assert.doesNotMatch(md, /## a\n/); // nothing to say about a clean one
});
