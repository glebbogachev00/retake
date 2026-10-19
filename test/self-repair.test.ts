/** An install cut off mid-download leaves ffmpeg there but broken. "The file
    exists" was the whole check, so every render failed with EACCES. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("a broken ffmpeg is not taken for a working one", () => {
  const src = fs.readFileSync("src/self-repair.ts", "utf8");
  assert.ok(src.includes("if (runs(bin)) return bin;"), "the bundled ffmpeg must be checked by running it");
  assert.ok(/fs\.rmSync\(bin/.test(src), "a broken copy is removed before fetching again");
});
