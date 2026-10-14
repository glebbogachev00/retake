/** The window refuses any /api call without its token. A tool call that
    forgets it does not fail loudly — it reads a 401 as "no window", "no
    answer yet" or "nothing pending", and the person is sent to the terminal
    or left waiting forever. So every call the tools make carries it. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("every call from the tools to the window sends the window's token", () => {
  const src = fs.readFileSync("src/operator/tools.ts", "utf8");
  const calls = src.match(/fetch\([^;]*?\)\s*(?:\.then|\.catch|;)/g) ?? [];
  const toWindow = calls.filter((c) => /\$\{UI\}|fetch\(url,/.test(c));
  assert.ok(toWindow.length >= 8, `expected the tools to call the window, found ${toWindow.length}`);
  const bare = toWindow.filter((c) => !c.includes("uiHeaders()"));
  assert.deepEqual(bare, [], "these calls would get a 401 and read it as 'no window'");
});
