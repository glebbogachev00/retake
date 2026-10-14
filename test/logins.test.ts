/** Saved logins: one per site, filled in by name, never handed back.
    Every test here uses the plain-file store (RETAKE_LOGIN_FILE) so nothing
    touches the real Keychain; the Keychain itself is the same four calls. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "retake-logins-"));
process.env.RETAKE_LOGIN_FILE = path.join(DIR, "logins.json");

const { forgetLogin, hasLogin, listLogins, loginNames, readLogin, saveLogin, siteOf } = await import("../src/logins.js");
const { expandEnv, signInAt } = await import("../src/manifest.js");

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test("a site is its host and port — two local apps are two logins", () => {
  assert.equal(siteOf("https://App.Example.com/dashboard?x=1"), "app.example.com");
  assert.equal(siteOf("http://localhost:3000/app"), "localhost:3000");
  assert.notEqual(siteOf("http://localhost:3000"), siteOf("http://localhost:3179"));
});

test("a saved login is read back by field, and the list never carries a value", () => {
  saveLogin("app.example.com", { user: "demo@example.com", password: 'p@ss "q" \\ $x', totp: "JBSW Y3DP EHPK 3PXP" });
  assert.equal(readLogin("app.example.com", "password"), 'p@ss "q" \\ $x');
  assert.equal(readLogin("app.example.com", "totp"), "JBSWY3DPEHPK3PXP", "a pasted key loses its spaces");
  assert.ok(hasLogin("app.example.com"));
  assert.deepEqual(loginNames("app.example.com"), ["${LOGIN_USER}", "${LOGIN_PASSWORD}", "${TOTP:LOGIN_TOTP}"]);
  const listed = JSON.stringify(listLogins());
  assert.match(listed, /app\.example\.com/);
  assert.ok(!listed.includes("demo@example.com") && !listed.includes("p@ss"), "the site list is names only");
  assert.throws(() => saveLogin("app.example.com", { password: "two\nlines" }), /line break/);
});

test("${LOGIN_*} fills from the demo's own site; .env still wins; another site stops loudly", () => {
  saveLogin("localhost:4999", { user: "demo", password: "from-keychain" });
  signInAt("http://localhost:4999/app");
  assert.equal(expandEnv("${LOGIN_USER}:${LOGIN_PASSWORD}"), "demo:from-keychain");
  process.env.LOGIN_PASSWORD = "from-env";
  try { assert.equal(expandEnv("${LOGIN_PASSWORD}"), "from-env", "an existing .env value is not overridden"); }
  finally { delete process.env.LOGIN_PASSWORD; }
  signInAt("http://localhost:5000/");
  assert.throws(() => expandEnv("${LOGIN_PASSWORD}"), /no login is saved for localhost:5000 — .*retake login localhost:5000/);
  signInAt(null);
});

test("forgetting a site removes every field and its line in the list", () => {
  saveLogin("gone.example", { user: "u", password: "p" });
  assert.equal(forgetLogin("gone.example"), true);
  assert.equal(readLogin("gone.example", "password"), undefined);
  assert.ok(!listLogins().some((l) => l.site === "gone.example"));
  assert.equal(forgetLogin("gone.example"), false);
});

test("`retake login` saves from the terminal; `retake logins` shows sites, never values", () => {
  const env = { ...process.env, RETAKE_LOGIN_FILE: path.join(DIR, "cli.json") };
  const cli = path.resolve("dist/cli.js");
  const out = execFileSync(process.execPath, [cli, "login", "localhost:4321"], { input: "cli-user\ncli-secret-pw\n\n", env, encoding: "utf8" });
  assert.match(out, /saved\. Every demo of localhost:4321 signs in with \$\{LOGIN_USER\}, \$\{LOGIN_PASSWORD\}/);
  assert.ok(!out.includes("cli-secret-pw"));
  const list = execFileSync(process.execPath, [cli, "logins"], { env, encoding: "utf8" });
  assert.match(list, /localhost:4321 {2}· {2}user, password/);
  assert.ok(!list.includes("cli-user") && !list.includes("cli-secret-pw"));
  assert.match(execFileSync(process.execPath, [cli, "login", "localhost:4321", "--forget"], { env, encoding: "utf8" }), /forgot the login for localhost:4321/);
});

test("the window asks per site, saves to the store, and never sends a value back", async () => {
  const root = fs.mkdtempSync(path.join(DIR, "ws-"));
  fs.mkdirSync(path.join(root, "demos"));
  const port = 4300 + Math.floor(Math.random() * 600);
  const env = { ...process.env, RETAKE_OPEN: "0", RETAKE_ROOT: root, RETAKE_OUT: path.join(root, "outputs"), RETAKE_LOGIN_FILE: path.join(DIR, "window.json") };
  const ui = spawn(process.execPath, [path.resolve("dist/cli.js"), "ui", "--port", String(port)], { stdio: "ignore", env });
  try {
    const base = `http://127.0.0.1:${port}`;
    const until = Date.now() + 30_000;
    for (;;) {
      try { if ((await fetch(base + "/")).ok) break; } catch { /* not yet */ }
      if (Date.now() > until) throw new Error("the window never came up");
      await new Promise((r) => setTimeout(r, 300));
    }
    const token = fs.readFileSync(path.join(root, ".drafts", "ui-token"), "utf8").trim();
    const post = (p: string, body: unknown, headers: Record<string, string> = { "x-retake-token": token }) =>
      fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

    assert.equal((await post("/api/logins/request", { url: "http://localhost:4888/app", why: "x" }, {})).status, 401, "no token, no form");
    const { id } = await (await post("/api/logins/request", { url: "http://localhost:4888/app", why: "The dashboard is behind a login." })).json() as { id: string };
    const again = await (await post("/api/logins/request", { url: "http://localhost:4888/other", why: "y" })).json() as { id: string };
    assert.equal(again.id, id, "one form per site, however often it is asked");
    const pending = await (await fetch(base + "/api/logins/pending", { headers: { "x-retake-token": token } })).json() as { site: string; store: string }[];
    assert.deepEqual(pending.map((p) => p.site), ["localhost:4888"]);

    assert.equal((await post(`/api/logins/${id}/save`, { user: "demo", password: "" })).status, 400, "both fields, or nothing");
    const saved = await post(`/api/logins/${id}/save`, { user: "demo", password: "window-secret-pw" });
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes("window-secret-pw"));
    const state = await (await fetch(`${base}/api/logins/${id}`, { headers: { "x-retake-token": token } })).text();
    assert.match(state, /"filled":"login"/);
    assert.match(state, /"saved":true/);
    assert.ok(!state.includes("window-secret-pw") && !state.includes("\"demo\""));
    const stored = JSON.parse(fs.readFileSync(env.RETAKE_LOGIN_FILE, "utf8"));
    assert.equal(stored["localhost:4888"].password, "window-secret-pw");
  } finally {
    ui.kill();
  }
});
