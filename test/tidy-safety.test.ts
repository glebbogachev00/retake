/** tidy must never remove a raw recording without being asked, twice.
    A routine `tidy --apply` deleted a whole 68-second recording — folder,
    raw video and all — because its take had `ok: false`, while reporting
    that it was reclaiming re-renderable files. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planTidy } from "../src/tidy.js";

function workspace(takeOk: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tidy-"));
  const out = path.join(root, "outputs"), demos = path.join(root, "demos");
  const dir = path.join(out, "demo");
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(demos);
  fs.writeFileSync(path.join(demos, "demo.yaml"), "name: demo\n");
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify({ ok: takeOk, timeline: [] }));
  fs.writeFileSync(path.join(dir, "demo.webm"), "the only copy");
  fs.writeFileSync(path.join(dir, "demo.mp4"), "deliverable");
  fs.writeFileSync(path.join(dir, "master.mp4"), "re-renderable");
  return { out, demos, dir };
}
const removed = (plan: ReturnType<typeof planTidy>) => plan.groups.flatMap((g) => g.files);

test("a failed take's raw recording survives the default sweep", () => {
  const { out, demos, dir } = workspace(false);
  const files = removed(planTidy(out, { demosDir: demos }));
  assert.ok(!files.includes(dir), "the whole folder must not be swept by default");
  assert.ok(!files.some((f) => f.endsWith(".webm")), "the raw recording is the only thing a re-render cannot rebuild");
});

test("it still offers to, when explicitly asked", () => {
  const { out, demos, dir } = workspace(false);
  assert.ok(removed(planTidy(out, { demosDir: demos, failed: true })).includes(dir));
});

test("a healthy take keeps its raw and its deliverable, and loses only the master", () => {
  const { out, demos } = workspace(true);
  const files = removed(planTidy(out, { demosDir: demos }));
  assert.ok(files.some((f) => f.endsWith("master.mp4")));
  assert.ok(!files.some((f) => f.endsWith("demo.mp4") && !f.endsWith("master.mp4")));
  assert.ok(!files.some((f) => f.endsWith(".webm")));
});
