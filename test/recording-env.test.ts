/** The environment is the thing that loses takes. Six in one session, none of
    them to the recorder: a real cloud token in .env.local, a browser tab still
    attached pushing the owner's board back in, a server caching state so the
    seed only applied at boot, and two runs racing one output folder. Declaring
    it is cheap; discovering it from a frame is not. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EnvSpec, loadEnvSpec } from "../src/recording-env.js";

function spec(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-env-"));
  const f = path.join(dir, "environment.yaml");
  fs.writeFileSync(f, body);
  return f;
}

const MINIMAL = `name: demo-app
start:
  command: npm run dev
  cwd: /tmp
  port: 3179
`;

test("an environment declares how to start the app, and defaults to resetting it", () => {
  const s = loadEnvSpec(spec(MINIMAL));
  assert.equal(s.name, "demo-app");
  assert.equal(s.start.port, 3179);
  assert.equal(s.reset.restart, true, "most apps cache state in server memory; inheriting the last take is the default failure");
  assert.deepEqual(s.reset.clear, []);
});

test("a variable can be BLANKED, which is what stops a real token reaching a real account", () => {
  const s = loadEnvSpec(spec(`${MINIMAL}  env:
    UPSTASH_REDIS_REST_URL: ""
    APP_PASSWORD: ""
`));
  // Empty string, not absent: .env files are read after the process
  // environment, so "" is what an app's own "is it configured" check fails on.
  assert.equal(s.start.env.UPSTASH_REDIS_REST_URL, "");
  assert.ok("APP_PASSWORD" in s.start.env);
});

test("expectations carry an ABSENT list, because real data leaking in is invisible to a present-only check", () => {
  const s = loadEnvSpec(spec(`${MINIMAL}expect:
  path: /app
  present:
    - "button.tab"
  absent:
    - "text=a real person's note"
`));
  assert.equal(s.expect?.path, "/app");
  assert.deepEqual(s.expect?.present, ["button.tab"]);
  assert.deepEqual(s.expect?.absent, ["text=a real person's note"], "you cannot assert the absence of what you did not name");
});

test("a malformed environment is refused by name, not silently half-applied", () => {
  assert.throws(() => loadEnvSpec(spec("name: x\nstart:\n  command: npm run dev\n  cwd: /tmp\n")), /start\.port/);
  assert.throws(() => loadEnvSpec(spec("start:\n  command: x\n  cwd: /tmp\n  port: 3000\n")), /name/);
  // A port below 1024 is a privileged port and never a dev server.
  assert.throws(() => loadEnvSpec(spec("name: x\nstart:\n  command: x\n  cwd: /tmp\n  port: 80\n")), /port/);
});

test("the shipped Capture environment blanks every path to the real account", () => {
  const f = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "demos", "environment.yaml");
  if (!fs.existsSync(f)) return; // a workspace without one is fine
  const s = loadEnvSpec(f);
  for (const key of ["APP_PASSWORD", "UPSTASH_REDIS_REST_URL", "BLOB_READ_WRITE_TOKEN"]) {
    assert.equal(s.start.env[key], "", `${key} must be blanked — it is how the owner's real board reached a recording`);
  }
  assert.ok(s.reset.restart, "Capture caches its board in server memory");
  assert.ok((s.expect?.absent.length ?? 0) > 0, "name the real data that must not be there");
});
