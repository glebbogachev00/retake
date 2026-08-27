/** The receipt each check leaves. It answers one question the window could
    not: has anybody actually looked at this take, or was it only recorded. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCurrent, noteCheck, readChecks } from "../src/ext/checked.js";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "checked-"));

test("a check records what it answered and which take it answered", () => {
  const d = dir();
  noteCheck(d, "verify", { takeFinishedAt: "2026-08-27T08:00:00Z", ok: true, count: 4, summary: "4 answered yes" });
  const all = readChecks(d);
  assert.equal(all.verify?.ok, true);
  assert.equal(all.verify?.count, 4);
  assert.ok(all.verify?.at, "it stamps when it ran");
});

test("checks accumulate rather than overwrite each other", () => {
  const d = dir();
  noteCheck(d, "verify", { takeFinishedAt: "t1", ok: true, count: 1, summary: "a" });
  noteCheck(d, "sweep", { takeFinishedAt: "t1", ok: null, count: 12, summary: "b" });
  const all = readChecks(d);
  assert.deepEqual(Object.keys(all).sort(), ["sweep", "verify"]);
});

test("running a check twice keeps the newest answer", () => {
  const d = dir();
  noteCheck(d, "sense", { takeFinishedAt: "t1", ok: null, count: 3, summary: "three questions" });
  noteCheck(d, "sense", { takeFinishedAt: "t2", ok: null, count: 0, summary: "the run adds up" });
  assert.equal(readChecks(d).sense?.summary, "the run adds up");
});

test("an answer about an older recording is not current", () => {
  const r = { at: "x", takeFinishedAt: "t1", ok: true, count: 1, summary: "s" };
  assert.equal(isCurrent(r, "t1"), true);
  assert.equal(isCurrent(r, "t2"), false, "a re-record makes every previous answer stale");
  assert.equal(isCurrent(r, undefined), false);
  assert.equal(isCurrent(undefined, "t1"), false, "never run is never current");
});

test("a receipt is never worth a failure — an unwritable folder is silent", () => {
  // A check must not fail because it could not write its own note.
  assert.doesNotThrow(() => noteCheck(path.join(os.tmpdir(), "definitely-not-here-" + Math.random().toString(36).slice(2)), "verify", { takeFinishedAt: "t", ok: true, count: 0, summary: "" }));
});

test("nothing recorded reads back as nothing, not as a crash", () => {
  assert.deepEqual(readChecks(dir()), {});
});
