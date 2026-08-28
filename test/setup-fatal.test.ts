/** A failed setup step used to be logged and then ignored: the take went on
    to record an app that had never reached the screen the demo is about, and
    reported success for it. Real browser, real page, real failure. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { record } from "../src/record.js";
import { loadManifest, type Manifest } from "../src/manifest.js";

const PORT = 4401;
const PAGE = `<!doctype html><title>t</title><h1 id="here">here</h1>`;
const server = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(PAGE); });

test.before(() => new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok)));
test.after(() => new Promise<void>((ok) => { server.close(() => ok()); }));

function manifest(setup: string, extra = ""): { m: Manifest; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-"));
  const f = path.join(dir, "t.yaml");
  fs.writeFileSync(f, [
    "name: t",
    `url: http://127.0.0.1:${PORT}/`,
    "preset: draft",
    "waitForSelector: \"#here\"",
    extra,
    "setup:",
    setup,
    "steps:",
    "  - { action: scene, label: a }",
    "  - { action: wait, ms: 200 }",
  ].filter(Boolean).join("\n"));
  return { m: loadManifest(f).manifest, dir };
}

test("a setup step that cannot happen stops the run instead of recording anyway", async () => {
  const { m, dir } = manifest('  - { action: click, selector: "#not-here", timeout: 1500 }');
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  await assert.rejects(
    () => record(m, { outDir: out, manifestDir: dir, headed: false, log: () => {} }),
    (e: Error) => {
      assert.match(e.message, /setup failed/);
      assert.match(e.message, /never reached its starting state/);
      return true;
    },
  );
  // And it left the picture behind, at the instant.
  assert.ok(fs.existsSync(path.join(out, "setup-failed.png")), "evidence must be on disk");
});

test("`onFail: continue` still carries on, for a step that really is optional", async () => {
  const { m, dir } = manifest('  - { action: click, selector: "#not-here", timeout: 1500 }', "onFail: continue");
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  const take = await record(m, { outDir: out, manifestDir: dir, headed: false, log: () => {} });
  assert.ok(take.timeline.length > 0, "the take still happened");
});

test("a setup that works records normally", async () => {
  const { m, dir } = manifest('  - { action: waitFor, selector: "#here", timeout: 3000 }');
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  const take = await record(m, { outDir: out, manifestDir: dir, headed: false, log: () => {} });
  assert.equal(take.ok, true);
});
