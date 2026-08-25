/**
 * The frame-skipping in renderFrames is an optimization that MUST be invisible.
 *
 * It shipped once with the still-window guessed from the title's fade, which
 * was wrong: the card's rule keeps growing until twice that, so it froze
 * half-drawn and jumped at the exit. Sampling a few frames did not catch it —
 * the samples landed inside the frozen stretch and matched each other.
 *
 * So this compares EVERY frame against shooting every frame, byte for byte.
 * If a template's animation is ever extended past what it declares in
 * `__still`, this fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import { __test_cardHtml } from "../src/cards.js";

type Win = [number, number];

/** The same loop renderFrames runs, with the still-window optionally ignored. */
async function frameHashes(html: string, w: number, h: number, ms: number, fps: number, useStill: boolean): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-frametest-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(html, { waitUntil: "load" });
    const still = useStill ? await page.evaluate(() => (window as unknown as { __still?: Win }).__still) : undefined;
    const margin = 1000 / fps;
    const held = (t: number) => !!still && still[1] - still[0] > 2 * margin && t * 1000 >= still[0] + margin && t * 1000 <= still[1] - margin;
    const frames = Math.max(2, Math.round((ms / 1000) * fps));
    const out: string[] = [];
    let settled = "";
    for (let i = 0; i < frames; i++) {
      const t = i / fps;
      const file = path.join(dir, `f${i}.png`);
      if (!held(t) || !settled) {
        await page.evaluate((m) => (window as unknown as { __seek: (t: number) => void }).__seek(m), t * 1000);
        await page.screenshot({ path: file });
        if (held(t) && !settled) settled = file;
      } else fs.copyFileSync(settled, file);
      out.push(crypto.createHash("md5").update(fs.readFileSync(file)).digest("hex"));
    }
    return out;
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const THEME = { background: "#edefe8", ink: "#22221f" };

test("a card's skipped frames are identical to shooting every one", async () => {
  const [w, h, ms, fps] = [1280, 720, 2000, 30];
  const html = __test_cardHtml(w, h, THEME, "capture.", "Say it messy. It lands sorted.", ms);
  const every = await frameHashes(html, w, h, ms, fps, false);
  const skipped = await frameHashes(html, w, h, ms, fps, true);
  const differing = every.map((x, i) => (x === skipped[i] ? -1 : i)).filter((i) => i >= 0);
  assert.equal(differing.length, 0, `frames differ at t=${differing.map((i) => (i / fps).toFixed(2)).join(", ")}s — the template animates outside the window it declares in __still`);
  assert.ok(every.length >= 50, "expected a full timeline");
});

test("a card too short to hold still is shot in full", async () => {
  // Nothing to skip when the entrance and exit meet: the guard must not
  // produce a copied frame in a stretch that is still moving.
  const [w, h, ms, fps] = [640, 360, 400, 30];
  const html = __test_cardHtml(w, h, THEME, "x.", undefined, ms);
  const every = await frameHashes(html, w, h, ms, fps, false);
  const skipped = await frameHashes(html, w, h, ms, fps, true);
  assert.deepEqual(skipped, every);
});
