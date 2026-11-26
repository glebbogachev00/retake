/**
 * The front door: `npx retake-demos https://your.app` with nothing set up.
 * It has to tell an address from a command or a file, make the workspace
 * quietly in one decided place, and open the window at "Add an app".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addAppPath, asAddress, firstRun, isWorkspace, viaNpx, workspaceFor } from "../src/first-run.js";

test("an address is told apart from a command, a flag or a file", () => {
  assert.equal(asAddress("https://app.example.com/x"), "https://app.example.com/x");
  assert.equal(asAddress("app.example.com"), "https://app.example.com/");
  assert.equal(asAddress("localhost:3000"), "http://localhost:3000/");
  assert.equal(asAddress("127.0.0.1:5173/admin"), "http://127.0.0.1:5173/admin");
  for (const not of ["run", "watch", "demo", "--help", "-V", "demos/x.yaml", "notes.md", "outputs/x", "two words", "", undefined]) {
    assert.equal(asAddress(not as string), null, String(not));
  }
});

test("the workspace is this folder when it already is one, otherwise the one decided place", () => {
  const here = fs.mkdtempSync(path.join(os.tmpdir(), "retake-fr-"));
  const home = path.join(here, "home-Retake");
  assert.equal(isWorkspace(here), false);
  assert.equal(workspaceFor(here, home), home);
  fs.mkdirSync(path.join(here, "watch"));
  assert.equal(workspaceFor(here, home), here);
  fs.rmSync(here, { recursive: true, force: true });
});

test("the window opens at Add an app, with the address when there is one", () => {
  assert.equal(addAppPath(null), "/watch/add");
  assert.equal(addAppPath("https://a.example/"), "/watch/add?url=https%3A%2F%2Fa.example%2F");
  assert.equal(viaNpx({ npm_command: "exec" }), true);
  assert.equal(viaNpx({ npm_command: "run-script" }), false);
  assert.equal(viaNpx({}), false);
});

test("a first run makes the workspace quietly and opens the window it started", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retake-fr-"));
  const cwd = path.join(tmp, "somewhere"), home = path.join(tmp, "Retake");
  fs.mkdirSync(cwd);
  const said: string[] = [];
  let inited = "";
  // A stand-in window: answers like Retake's for a moment, then closes.
  const fake = `const port=+process.argv.at(-1);require("http").createServer((q,r)=>{r.setHeader("x-retake-version","test");r.end("ok")}).listen(port,"127.0.0.1");setTimeout(()=>process.exit(0),1500);`;
  process.env.RETAKE_NO_OPEN = "1";
  await firstRun("https://app.example.com/", {
    init: (root) => { inited = root; },
    cli: { command: process.execPath, args: ["-e", fake, "--"] },
    browser: { present: () => true, install: () => true },
    say: (l) => said.push(l),
    port: 47310 + Math.floor(Math.random() * 500),
  }, cwd, home);
  assert.equal(inited, home, "the workspace is made in the decided place");
  assert.ok(fs.existsSync(path.join(home, "watch")));
  assert.match(said[0], /^Retake is open at http:\/\/localhost:\d+\/watch\/add\?url=https%3A%2F%2Fapp\.example\.com%2F$/);
  assert.match(said[1], /Your workspace is .*Retake\./);
  assert.equal(said.length, 2, "nothing else is said");
  fs.rmSync(tmp, { recursive: true, force: true });
});
