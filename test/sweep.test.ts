/** sweep: which frames it looks at, and the promise that it looks at all of
    them. The judging itself is exercised by hand against real recordings —
    a checklist you cannot measure on real frames is a checklist you are
    guessing about. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LOOK_FOR, framesOf, sweep } from "../src/ext/sweep.js";
import type { Take } from "../src/record.js";
import type { Manifest } from "../src/manifest.js";

const take = (labels: string[]): Take => ({
  timeline: labels.map((label, i) => ({ index: i, action: "scene", label, start: i, end: i, ok: true })),
  duration: 10, trimBefore: 0, screenshots: [], startedAt: "", finishedAt: "", ok: true,
  quality: { preset: "p", width: 1, height: 1, scale: 1, fps: 30 },
} as unknown as Take);

function withStills(labels: string[], both = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
  fs.mkdirSync(path.join(dir, "stills"));
  labels.forEach((l, i) => {
    const n = String(i + 1).padStart(2, "0");
    if (both) fs.writeFileSync(path.join(dir, "stills", `${n}-${l}.png`), "");
    fs.writeFileSync(path.join(dir, "stills", `${n}-${l}-end.png`), "");
  });
  return dir;
}

test("every scene, never a sample — that is the whole point", () => {
  // sense samples a long demo because its question is about the run. sweep's
  // question is about each frame, so sampling would reintroduce exactly the
  // method that missed the bug this was built for.
  const labels = Array.from({ length: 40 }, (_, i) => `s${i}`);
  const got = framesOf(withStills(labels), take(labels));
  assert.equal(got.length, 40);
});

test("the end frame by default; --all adds the middles", () => {
  const dir = withStills(["a", "b"]);
  const ends = framesOf(dir, take(["a", "b"]));
  assert.deepEqual(ends.map((f) => path.basename(f.still)), ["01-a-end.png", "02-b-end.png"]);
  const all = framesOf(dir, take(["a", "b"]), true);
  assert.deepEqual(all.map((f) => path.basename(f.still)), ["01-a.png", "01-a-end.png", "02-b.png", "02-b-end.png"]);
  assert.equal(all[0].scene, "a (mid)");
});

test("a scene with only a middle frame is still looked at", () => {
  const dir = withStills(["a"], true);
  fs.unlinkSync(path.join(dir, "stills", "01-a-end.png"));
  const got = framesOf(dir, take(["a"]));
  assert.equal(got.length, 1);
  assert.match(got[0].still, /01-a\.png$/);
});

test("no stills, and no take, both say so rather than passing", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
  const noTake = await sweep({ name: "x" } as Manifest, empty);
  assert.match(noTake.lines[0], /no take\.json/);
  assert.equal(noTake.looked, 0);

  fs.writeFileSync(path.join(empty, "take.json"), JSON.stringify(take(["a"])));
  const noStills = await sweep({ name: "x" } as Manifest, empty);
  assert.match(noStills.lines[0], /no stills/);
  assert.equal(noStills.looked, 0);
});

test("the checklist is closed — no catch-all item", () => {
  // The moment one of these says "anything else that looks wrong", the space
  // is infinite again and the tool goes back to guessing.
  assert.ok(LOOK_FOR.length >= 8 && LOOK_FOR.length <= 14);
  for (const item of LOOK_FOR) {
    assert.match(item, /^[A-Z][A-Z ]+ — /, `each item names its kind: ${item}`);
    assert.doesNotMatch(item, /anything else|other issues|general/i, `catch-all found: ${item}`);
  }
  assert.equal(new Set(LOOK_FOR.map((l) => l.split(" — ")[0])).size, LOOK_FOR.length, "kinds must be distinct");
});
