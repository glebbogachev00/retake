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
    // And with the key. The Escape handler called a `shut()` that does not
    // exist in that scope — copied from a dialog that had one — so the key
    // threw and left the modal sitting there. The button was tested; the key
    // was not.
    await p.locator("#newsBtn").click();
    await p.waitForTimeout(400);
    assert.equal(await p.locator(".veil").count(), 1);
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    assert.equal(await p.locator(".veil").count(), 0, "Escape must close it too");
  });
  assert.deepEqual(errs, []);
});

test("the small print in the review area is readable", async () => {
  // Every label here is 11.5-12.5px, which WCAG calls normal text and wants at
  // 4.5:1. They sat between 3.62 and 4.19 — the part of the window that says
  // what has and has not been checked was the hardest part of it to read.
  const { errs } = await visit(1440, async (p) => {
    // Passed as source, not a function: tsx compiles named inner functions
    // with a `__name` helper that does not exist inside the page, so an
    // ordinary arrow const here throws a ReferenceError in the browser.
    const worst = (await p.evaluate(`(() => {
      const lum = (c) => { const ch = (c.match(/\\d+/g) || []).slice(0,3).map((n) => { const x = Number(n)/255; return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); }); return 0.2126*ch[0] + 0.7152*ch[1] + 0.0722*ch[2]; };
      const bg = (el) => { let n = el; while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(b)) return b; n = n.parentElement; } return 'rgb(255,255,255)'; };
      let low = 99;
      for (const sel of ['.rhead', '.rhint', '.checked', '.checked .why', '.checked .c']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const a = lum(getComputedStyle(el).color), b = lum(bg(el));
        low = Math.min(low, (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05));
      }
      return low;
    })()`)) as number;
    // 99 means the panel was not on screen for this demo; that is not a pass
    // to assert against, so only judge it when it was actually there.
    if (worst < 99) assert.ok(worst >= 4.5, `the quietest label measures ${worst.toFixed(2)}:1, under AA`);
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
