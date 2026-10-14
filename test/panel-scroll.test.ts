/** A scroll to something inside a scrolling panel — a dialog, a sidebar —
    must move that panel. The recorder used to move the page behind it, so the
    narration described cards the viewer never saw, while the dry run (which
    used the browser's own scrollIntoView) passed. */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { scrollPanel } from "../src/record.js";

const PAGE = `<!doctype html><body style="margin:0;height:3000px">
  <div id="panel" style="position:fixed;top:40px;left:40px;width:400px;height:300px;overflow:auto">
    <div style="height:1200px"></div><p id="deep">deep in the panel</p><div style="height:400px"></div>
  </div>
  <p id="onpage" style="position:absolute;top:2400px">on the page</p>
</body>`;

test("a target inside a panel scrolls the panel, not the page", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(PAGE);
    assert.equal(await scrollPanel(page, "#deep", { align: "center", speed: 3, timeout: 2000 }), true);
    const after = await page.evaluate(`({ panel: document.getElementById('panel').scrollTop, page: window.scrollY, top: document.getElementById('deep').getBoundingClientRect().top })`) as { panel: number; page: number; top: number };
    assert.ok(after.panel > 900, `the panel moved (${after.panel})`);
    assert.equal(after.page, 0, "the page behind it did not");
    assert.ok(after.top > 40 && after.top < 340, "the target is inside the panel's visible area");
    // A target on the page itself is the page's to scroll.
    assert.equal(await scrollPanel(page, "#onpage", { align: "center", instant: true, timeout: 2000 }), false);
  } finally {
    await browser.close();
  }
});
