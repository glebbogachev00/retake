/** Not asking twice about a picture that has not changed — and, because the
    judge is not deterministic, adding to what is known rather than replacing
    it when you do ask again. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keyFor, memo } from "../src/ext/memo.js";

function frame(bytes: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-"));
  const f = path.join(dir, "still.png");
  fs.writeFileSync(f, bytes);
  return { dir, f };
}

test("the key is the CONTENT of the frame, not its name", () => {
  // The same path holds different pixels after every take. Keying on the name
  // would answer a new recording with an old answer.
  const { f } = frame("aaa");
  const before = keyFor(f, "q");
  fs.writeFileSync(f, "bbb");
  assert.notEqual(keyFor(f, "q"), before);
});

test("the question is part of the key", () => {
  const { f } = frame("aaa");
  assert.notEqual(keyFor(f, "one question"), keyFor(f, "another"));
});

test("an unreadable frame has no key, so it is asked about rather than guessed", () => {
  assert.equal(keyFor(path.join(os.tmpdir(), "nope-" + Math.random()), "q"), null);
});

test("an unchanged frame is answered from what is known", () => {
  const { dir, f } = frame("aaa");
  const a = memo<string[]>(dir);
  a.remember(f, "q", ["one"]);
  a.flush();
  const b = memo<string[]>(dir);
  assert.deepEqual(b.recall(f, "q"), ["one"]);
});

test("a frame that changed by a byte is asked again", () => {
  const { dir, f } = frame("aaa");
  const a = memo<string[]>(dir);
  a.remember(f, "q", ["one"]);
  a.flush();
  fs.writeFileSync(f, "aab");
  assert.equal(memo<string[]>(dir).recall(f, "q"), null);
});

test("asking again ADDS to what is known — it never throws findings away", () => {
  // Measured on a real frame: two sweeps of the same image returned
  // overlapping but different sets, and one missed a bug the other caught.
  // Replacing would make a second look a coin toss instead of an improvement.
  const { dir, f } = frame("aaa");
  const union = (was: string[], now: string[]) => [...was, ...now.filter((x) => !was.includes(x))];
  const a = memo<string[]>(dir);
  a.remember(f, "q", ["overlap"], union);
  a.remember(f, "q", ["contrast"], union);
  a.flush();
  assert.deepEqual(memo<string[]>(dir).recall(f, "q"), ["overlap", "contrast"]);
});

test("`reask` means ask anyway — it does not mean forget", () => {
  const { dir, f } = frame("aaa");
  const a = memo<string[]>(dir);
  a.remember(f, "q", ["one"]);
  a.flush();
  const b = memo<string[]>(dir, { reask: true });
  assert.equal(b.recall(f, "q"), null, "it must ask again");
  assert.deepEqual(b.all(f, "q"), ["one"], "but everything known is still there to add to");
});

test("nothing to remember writes nothing", () => {
  const { dir, f } = frame("aaa");
  const a = memo<string[]>(dir);
  a.recall(f, "q");
  a.flush();
  assert.equal(fs.existsSync(path.join(dir, ".answers.json")), false);
});

test("a store it cannot write is not a failure", () => {
  const gone = path.join(os.tmpdir(), "not-here-" + Math.random().toString(36).slice(2));
  const a = memo<string[]>(gone);
  a.remember(path.join(gone, "x.png"), "q", ["one"]);
  assert.doesNotThrow(() => a.flush());
});
