/** dry must predict run. That means one wait, and a wait that works with
    every selector a manifest is allowed to use — including Playwright's own,
    which are not CSS. Real browser, real page. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { waitForStep } from "../src/waiting.js";

let browser: Browser, page: Page;
test.before(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
test.after(async () => { await browser?.close(); });

const CSS = "#out";
const PLAYWRIGHT = 'div:has-text("streamed")';

test("minChars waits for the text to arrive — with a plain CSS selector", async () => {
  await page.setContent(`<div id="out"></div><script>setTimeout(()=>{document.getElementById('out').textContent='0123456789';},200)</script>`);
  await waitForStep(page, { selector: CSS, minChars: 10, timeout: 4000 });
  assert.equal((await page.locator(CSS).innerText()).length, 10);
});

test("minChars works with a Playwright selector, which is NOT valid CSS", async () => {
  // The bug a real recording found: this ran document.querySelector(sel) in
  // the page, which throws on `:has-text()`. dry passed, the take fell over.
  await page.setContent(`<div id="out">streamed</div><script>setTimeout(()=>{document.getElementById('out').textContent='streamed and then some more';},200)</script>`);
  await waitForStep(page, { selector: PLAYWRIGHT, minChars: 20, timeout: 4000 });
  assert.ok((await page.locator("#out").innerText()).length >= 20);
});

test("minChars that never arrives fails, and the message says what it wanted", async () => {
  await page.setContent(`<div id="out">short</div>`);
  await assert.rejects(
    () => waitForStep(page, { selector: CSS, minChars: 500, timeout: 900 }),
    (e: Error) => { assert.match(e.message, /500\+ characters/); assert.match(e.message, /it had 5/); return true; },
  );
});

test("stableMs waits for a changing subtree to go quiet", async () => {
  await page.setContent(`<div id="out">a</div><script>
    let n = 0; const t = setInterval(() => { document.getElementById('out').textContent += 'x'; if (++n > 5) clearInterval(t); }, 60);
  </script>`);
  const t0 = Date.now();
  await waitForStep(page, { selector: CSS, stableMs: 300, timeout: 6000 });
  assert.ok(Date.now() - t0 >= 300, "it cannot settle sooner than the quiet it was asked for");
});

test("stableMs works with a Playwright selector too", async () => {
  await page.setContent(`<div id="out">streamed</div>`);
  await waitForStep(page, { selector: PLAYWRIGHT, stableMs: 200, timeout: 4000 });
});

test("stableMs on something that never stops changing fails, and says so", async () => {
  await page.setContent(`<div id="out">a</div><script>setInterval(()=>{document.getElementById('out').textContent+='x';},30)</script>`);
  await assert.rejects(
    () => waitForStep(page, { selector: CSS, stableMs: 800, timeout: 1500 }),
    (e: Error) => { assert.match(e.message, /kept changing/); return true; },
  );
});

test("`gone` waits for something to leave", async () => {
  await page.setContent(`<div id="out">here</div><script>setTimeout(()=>{document.getElementById('out').remove();},200)</script>`);
  await waitForStep(page, { selector: CSS, gone: true, timeout: 4000 });
});

test("the cap dry passes shortens the wait without changing what is waited for", async () => {
  await page.setContent(`<div id="out">short</div>`);
  const t0 = Date.now();
  await assert.rejects(() => waitForStep(page, { selector: CSS, minChars: 500, timeout: 30_000 }, { cap: 800 }));
  assert.ok(Date.now() - t0 < 4000, `a capped wait must not run to the manifest's timeout (took ${Date.now() - t0}ms)`);
});

test("`scroll to: bottom` means the page's end in BOTH dry and run", async () => {
  // Found by recording Retake's own guide page: dry treated "bottom" as a
  // selector, looked for an element called bottom, timed out, and failed a
  // step that records perfectly. The starter demo shipped by `retake init`
  // uses it, so a new person's first dry run failed on a demo that works.
  const { dryRun } = await import("../src/dryrun.js");
  const { loadManifest } = await import("../src/manifest.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const http = await import("node:http");

  const port = 4402;
  const srv = http.createServer((_q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(`<h1 id="top">t</h1><div style="height:3000px"></div>`); });
  await new Promise<void>((ok) => srv.listen(port, "127.0.0.1", ok));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scroll-"));
  const f = path.join(dir, "s.yaml");
  fs.writeFileSync(f, [
    "name: s", `url: http://127.0.0.1:${port}/`, "preset: draft", 'waitForSelector: "#top"',
    "steps:", "  - { action: scene, label: a }", "  - { action: scroll, to: bottom }", "  - { action: scroll, to: top }",
  ].join("\n"));
  try {
    const r = await dryRun(loadManifest(f).manifest, dir, () => {}, { outRoot: dir });
    assert.equal(r.failures, 0, `dry failed a scroll the recorder performs: ${r.lines.filter((l) => l.includes("✗")).join(" | ")}`);
  } finally {
    await new Promise<void>((ok) => { srv.close(() => ok()); });
  }
});
