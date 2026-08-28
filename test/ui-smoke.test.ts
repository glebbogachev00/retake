/**
 * The window, actually loaded, actually clicked.
 *
 * `chat.html` is one long script block. In a single day it broke four separate
 * ways and every one reached a running window:
 *
 *   · `const st` redeclared in the same scope — a syntax error, blank page
 *   · `RUNNING` declared inside a block the library code could not see
 *   · `liveFromDisk` in a different scope from the ticker that reads it
 *   · `display = ''` to show an element the stylesheet sets to `display:none`
 *
 * Every one was found by a person opening the page and looking. None would
 * have been caught by a unit test, and all four would have been caught by
 * this: boot the real server, load the real page, click the things a person
 * clicks, and fail on any console error.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser } from "playwright";

const PORT = 4403;
let ui: ChildProcess, browser: Browser, token = "";

test.before(async () => {
  ui = spawn(process.execPath, ["dist/cli.js", "ui", "--port", String(PORT)], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RETAKE_OPEN: "0" },
  });
  // Wait for it to answer rather than sleeping a guessed number of seconds.
  const until = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break; } catch { /* not yet */ }
    if (Date.now() > until) throw new Error("the window never came up");
    await new Promise((r) => setTimeout(r, 300));
  }
  const { readFileSync } = await import("node:fs");
  token = readFileSync(".drafts/ui-token", "utf8").trim();
  browser = await chromium.launch();
});

test.after(async () => { await browser?.close(); ui?.kill(); });

/** Load the page and hand back everything the browser complained about. */
async function visit(width: number, run: (p: import("playwright").Page) => Promise<void>) {
  const p = await browser.newPage({ viewport: { width, height: 900 } });
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push("pageerror: " + String(e)));
  p.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });
  const failed: string[] = [];
  p.on("response", (r) => { if (r.url().includes(`:${PORT}/`) && r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1500);
  await run(p);
  await p.close();
  return { errs, failed };
}

test("the window loads and opens a demo without a single console error", async () => {
  const { errs, failed } = await visit(1440, async (p) => {
    for (const d of await p.locator("#demos details").all()) await d.evaluate((e) => ((e as HTMLDetailsElement).open = true));
    await p.waitForTimeout(400);
    const rows = p.locator("#demos .nm");
    if (await rows.count()) {
      await rows.first().click({ force: true });
      await p.waitForTimeout(2000);
      // The parts most often broken by a scope mistake.
      assert.ok(await p.locator("#vidState").innerText(), "a take must state its own condition");
      assert.ok(await p.locator("#review").isVisible(), "the optional review area must render");
    }
  });
  assert.deepEqual(errs, []);
  assert.deepEqual(failed, []);
});

test("what's new opens, expands, and closes", async () => {
  const { errs } = await visit(1440, async (p) => {
    await p.locator("#newsBtn").click();
    await p.waitForTimeout(500);
    assert.equal(await p.locator(".rel").count(), 1, "it opens on the newest release only");
    const all = p.locator("#newsAll");
    if (await all.count()) { await all.click(); await p.waitForTimeout(300); assert.ok((await p.locator(".rel").count()) > 1); }
    await p.locator("#newsClose").click();
    await p.waitForTimeout(200);
    assert.equal(await p.locator(".veil").count(), 0, "closing must remove it");
  });
  assert.deepEqual(errs, []);
});

test("the guide renders its flow, at both sizes", async () => {
  for (const w of [1100, 390]) {
    const p = await browser.newPage({ viewport: { width: w, height: 900 } });
    const errs: string[] = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    await p.goto(`http://127.0.0.1:${PORT}/guide`, { waitUntil: "networkidle" });
    assert.equal(await p.locator(".beat").count(), 3, `three beats at ${w}px`);
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `no sideways scrolling at ${w}px`);
    assert.deepEqual(errs, [], `errors at ${w}px`);
    await p.close();
  }
});

test("nothing scrolls sideways on a phone, and the pills keep their shape", async () => {
  const p = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs: string[] = [];
  p.on("pageerror", (e) => errs.push(String(e)));
  await p.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });
  await p.waitForTimeout(1200);
  // A pill that wraps inside its own border is taller than one line of it.
  const h = await p.locator(".chip").first().evaluate((e) => e.getBoundingClientRect().height);
  assert.ok(h <= 40, `a header pill wrapped inside itself (${Math.round(h)}px tall)`);
  assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.deepEqual(errs, []);
  await p.close();
});

test("the API still refuses what it should, on the real routes", async () => {
  const call = (h: Record<string, string>, body = "{}") =>
    fetch(`http://127.0.0.1:${PORT}/api/start`, { method: "POST", headers: h, body }).then((r) => r.status);
  assert.equal(await call({ "content-type": "application/json" }), 401, "no token");
  assert.equal(await call({ "content-type": "application/json", "x-retake-token": token, origin: "https://evil.example" }), 403, "hostile origin");
  assert.equal(await call({ "content-type": "text/plain", "x-retake-token": token }), 415, "unpreflighted type");
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/demos`)).status, 401, "guarded GET");
  assert.equal((await fetch(`http://127.0.0.1:${PORT}/api/demos`, { headers: { "x-retake-token": token } })).status, 200);
});
