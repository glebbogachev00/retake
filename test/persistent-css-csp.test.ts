/** persistentCss is how a demo hides what must not be filmed — a secret, a QR
    code. A page whose Content-Security-Policy forbids inline styles (Zitadel's
    sign-in does) dropped Retake's <style> element without a word, so a blur
    meant to hide an authenticator secret left it on camera. */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { persistentCssScript } from "../src/record.js";

const PAGE = `<!doctype html><html><head></head><body><div id="qr">QR</div></body></html>`;

for (const [what, csp] of [["a strict style policy", "default-src 'self'; style-src 'self'"], ["no policy", ""]] as const) {
  test(`persistentCss applies on a page with ${what}`, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addInitScript(persistentCssScript("#qr { filter: blur(9px) !important; }"));
      await context.route("https://csp.test/", (r) => r.fulfill({
        contentType: "text/html", body: PAGE, headers: csp ? { "content-security-policy": csp } : {},
      }));
      const page = await context.newPage();
      await page.goto("https://csp.test/");
      assert.equal(await page.locator("#qr").evaluate((e) => getComputedStyle(e).filter), "blur(9px)");
    } finally {
      await browser.close();
    }
  });
}
