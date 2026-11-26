/** Watch mode: what a session leaves on disk, the pace between steps, and
    the masks over what nobody may see. The last test drives a real browser
    with no window open — the case a script must survive. */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import {
  MaskList, WATCH_PAUSE_MS, appendFlag, concatList, gateDecision, isCssSelector, isSpeed, jpegSize, nextFixName, queueStatus,
  readFlagsIn, readSteps, renderReport, sessionId, slugify, stamp, stepAt, updateFlag, writeFixRequest, writeMeta, writeSteps,
  type SessionMeta, type StepRecord,
} from "../src/watch/session.js";
import { maskScript } from "../src/watch/page-scripts.js";
import { startWatch } from "../src/watch.js";

const step = (n: number, t: number, tEnd: number | null, over: Partial<StepRecord> = {}): StepRecord => ({
  n, scenario: null, intent: `step ${n}`, expect: `expect ${n}`, result: tEnd === null ? null : "pass", note: "",
  startedAt: new Date(1.79e12 + t).toISOString(), endedAt: tEnd === null ? null : new Date(1.79e12 + tEnd).toISOString(), t, tEnd, url: "http://app/", screenshot: null, ...over,
});

function session(): { dir: string; meta: SessionMeta } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "watch-"));
  const dir = path.join(root, "watch", "portal-20261123-1400");
  fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
  const meta: SessionMeta = { id: "portal-20261123-1400", title: "Portal", startedAt: new Date(1.79e12).toISOString(), endedAt: null, video: null };
  writeMeta(dir, meta);
  return { dir, meta };
}

test("a session folder is named after its title and the minute it started, and never reuses a name", () => {
  const d = new Date(2026, 10, 23, 14, 5);
  assert.equal(stamp(d), "20261123-1405");
  assert.equal(slugify("Client portal – licences"), "client-portal-licences");
  assert.equal(slugify("   "), "session");
  const taken = new Set(["client-portal-licences-20261123-1405", "client-portal-licences-20261123-1405-2"]);
  assert.equal(sessionId("Client portal – licences", d, (x) => taken.has(x)), "client-portal-licences-20261123-1405-3");
});

test("a moment belongs to the step running then, or the last one that had started", () => {
  const steps = [step(1, 1000, 3000), step(2, 4000, 6000), step(3, 7000, null)];
  assert.equal(stepAt(steps, 500), null);       // before anything
  assert.equal(stepAt(steps, 2000), 1);         // during step 1
  assert.equal(stepAt(steps, 3500), 1);         // between 1 and 2: still about step 1
  assert.equal(stepAt(steps, 6500), 2);
  assert.equal(stepAt(steps, 99_000), 3);       // the step still running
});

test("the pace: Next always goes, Play holds about 1.5 s, Pause waits for Play or Next", () => {
  // One switch, Play or Pause: there is no "fast" any more.
  assert.equal(isSpeed("fast"), false);
  assert.deepEqual(gateDecision({ speed: "step", elapsedMs: 60_000, pressed: true, hold: false, ui: true }), { go: true });
  const w = gateDecision({ speed: "watch", elapsedMs: 400, pressed: false, hold: false, ui: true });
  assert.deepEqual(w, { go: false, waitMs: WATCH_PAUSE_MS - 400 });
  assert.deepEqual(gateDecision({ speed: "watch", elapsedMs: WATCH_PAUSE_MS, pressed: false, hold: false, ui: true }), { go: true });
  const s = gateDecision({ speed: "step", elapsedMs: 60_000, pressed: false, hold: false, ui: true });
  assert.equal(s.go, false);
  // Writing a note holds Play past its pause.
  assert.equal(gateDecision({ speed: "watch", elapsedMs: 5000, pressed: false, hold: true, ui: true }).go, false);
  // Nobody can press Next without a window: Pause falls back to Play's hold.
  assert.deepEqual(gateDecision({ speed: "step", elapsedMs: 0, pressed: false, hold: false, ui: false }), { go: false, waitMs: WATCH_PAUSE_MS });
  assert.deepEqual(gateDecision({ speed: "step", elapsedMs: WATCH_PAUSE_MS, pressed: false, hold: false, ui: false }), { go: true });
});

test("masks: CSS is applied by the page itself, Playwright-only selectors are found and marked", () => {
  for (const s of ["#password", "input[type=password]", ".qr canvas", "[data-testid=totp]", "img[alt='QR code']"]) assert.ok(isCssSelector(s), s);
  for (const s of ["text=Secret", "role=textbox[name=Password]", "xpath=//input", "//input", "#a >> nth=1", "button:has-text('Key')", "internal:label=\"x\""]) assert.ok(!isCssSelector(s), s);
  const list = new MaskList();
  assert.ok(list.add("#password"));
  assert.ok(!list.add(" #password "), "the same selector twice is one mask");
  assert.ok(list.add(".qr"));
  assert.deepEqual(list.list(), ["#password", ".qr"]);
  assert.ok(list.remove(".qr"));
  assert.ok(!list.remove(".qr"));
  assert.deepEqual(list.list(), ["#password"]);
  // The in-page script carries exactly the ops it was given, as data.
  const js = maskScript({ add: ["#a\"b"], remove: [".c"] });
  assert.ok(js.includes(JSON.stringify(["#a\"b"])) && js.includes(JSON.stringify([".c"])));
  assert.ok(js.includes("adoptedStyleSheets"), "styles must not depend on inline <style>, which a strict CSP drops");
});

test("steps and flags are written as they happen, numbered in order, and readable mid-session", () => {
  const { dir } = session();
  writeSteps(dir, [step(1, 100, 900)]);
  assert.equal(readSteps(dir).length, 1);
  const a = appendFlag(dir, { kind: "unclear", step: 1, time: 0.5, at: new Date().toISOString(), note: "", screenshot: "shots/flag-01.jpg", url: "http://app/", source: "live" });
  const b = appendFlag(dir, { kind: "note", step: 1, time: 0.8, at: new Date().toISOString(), note: "label too faint", screenshot: null, url: "http://app/", source: "replay" });
  assert.deepEqual([a.n, b.n], [1, 2]);
  assert.equal(updateFlag(dir, 1, { note: "where does Renew go?" })?.note, "where does Renew go?");
  assert.equal(updateFlag(dir, 9, { note: "x" }), null);
  assert.deepEqual(readFlagsIn(dir).map((f) => [f.n, f.note, f.source]), [[1, "where does Renew go?", "live"], [2, "label too faint", "replay"]]);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "no half-written files left behind");
});

test("the report puts the person's flags first, then every step with its verdict", () => {
  const { meta } = session();
  const steps = [step(1, 0, 10, { scenario: "L4" }), step(2, 20, 30, { scenario: "L4", result: "fail", note: "no form" })];
  const md = renderReport({ ...meta, video: "session.mp4" }, steps, [
    { n: 1, kind: "unclear", step: 1, time: 0.01, at: "", note: "too faint", screenshot: "shots/flag-01.jpg", url: "http://app/a", source: "live" },
  ]);
  assert.ok(md.indexOf("## Flagged by you") < md.indexOf("## Steps"));
  assert.match(md, /1\. Step 1: step 1 \(live, 0:00\) — “too faint” \[screenshot\]\(shots\/flag-01\.jpg\)/);
  assert.match(md, /### L4/);
  assert.match(md, /- flagged: step 1/);
  assert.match(md, /- fail: step 2 — expected: expect 2 — no form/);
  assert.match(md, /2 steps · 1 passed · 1 failed · 1 flagged by you/);
});

test("notes become one fix request, and a note added afterwards becomes the next one", () => {
  const { dir } = session();
  writeSteps(dir, [step(1, 0, 1000)]);
  assert.equal(writeFixRequest(dir), null, "nothing to send without a note");
  appendFlag(dir, { kind: "note", step: 1, time: 0.4, at: "t", note: "Renew looks disabled", screenshot: "shots/flag-01.jpg", url: "http://app/l", source: "live" });
  const first = writeFixRequest(dir)!;
  assert.equal(first.name, "fix-request");
  const brief = fs.readFileSync(first.md, "utf8");
  for (const s of ["“Renew looks disabled”", "Step 1: step 1", "Expected: expect 1", "Result: pass", "URL: http://app/l", path.join(dir, "shots/flag-01.jpg")]) assert.ok(brief.includes(s), s);
  assert.equal(readFlagsIn(dir)[0].fix, "fix-request");
  assert.equal(writeFixRequest(dir), null, "a sent note is not sent twice");
  appendFlag(dir, { kind: "unclear", step: 1, time: 0.9, at: "t", note: "", screenshot: null, url: "", source: "replay" });
  assert.equal(nextFixName(dir), "fix-request-2");
  const second = writeFixRequest(dir)!;
  assert.equal(second.name, "fix-request-2");
  assert.equal(second.notes, 1);
  const status = queueStatus(path.dirname(dir));
  assert.equal(status.get(`${dir}#fix-request`), "sent");
  // An agent that picks one up appends its status; the last word wins.
  fs.appendFileSync(path.join(path.dirname(dir), "fix-queue.jsonl"), JSON.stringify({ dir, request: "fix-request", notes: 1, at: "t", status: "pr https://example/1" }) + "\n");
  assert.equal(queueStatus(path.dirname(dir)).get(`${dir}#fix-request`), "pr https://example/1");
});

test("the video plays each frame from when it arrived until the next, first from 0, last until the end", () => {
  const list = concatList([{ file: "a.jpg", t: 120 }, { file: "b.jpg", t: 1000 }, { file: "c.jpg", t: 2500 }], 4000);
  assert.equal(list, "ffconcat version 1.0\nfile 'a.jpg'\nduration 1.000\nfile 'b.jpg'\nduration 1.500\nfile 'c.jpg'\nduration 1.500\nfile 'c.jpg'\n");
  // 1×1 baseline JPEG header
  const jpg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffc0000b080001000201011100ffd9", "hex");
  assert.deepEqual(jpegSize(jpg), { width: 2, height: 1 });
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
});

test("with no window open, a session still records, masks, and writes its whole folder", { timeout: 60_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "watch-run-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    const w = await startWatch(page, { title: "No window", ui: "http://127.0.0.1:9", out, mask: "#secret" });
    assert.equal(w.link, null);
    await page.setContent(`<input id="secret" value="hunter2"><p class="later">QR</p><button onclick="this.textContent='done'">Go</button>`);
    await w.mask(page.getByText("QR"));
    await w.scenario("One");
    await w.step("Press Go", "It says done");
    await page.click("button");
    await w.result(true, "It said done");
    const masked = await page.evaluate(() => (window as unknown as { __retakeMask: { list(): string[] } }).__retakeMask.list());
    assert.equal(masked[0], "#secret");
    assert.match(masked[1], /^\[data-retake-mask~="m\d+"\]$/);
    assert.equal(await page.locator("p.later").getAttribute("data-retake-mask"), masked[1].match(/"(m\d+)"/)![1]);
    await w.unmask("#secret");
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __retakeMask: { list(): string[] } }).__retakeMask.list()), [masked[1]]);
    const { dir, flags } = await w.end();
    assert.equal(flags.length, 0);
    for (const f of ["session.mp4", "steps.json", "flags.json", "report.md", "session.json"]) assert.ok(fs.existsSync(path.join(dir, f)), f);
    assert.ok(!fs.existsSync(path.join(dir, ".frames")), "frames are tidied once the video exists");
    const steps = readSteps(dir);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].scenario, "One");
    assert.equal(steps[0].result, "pass");
    assert.ok(steps[0].screenshot && fs.existsSync(path.join(dir, steps[0].screenshot)));
    assert.ok(dir.startsWith(path.join(out, "watch")));
  } finally { await browser.close(); }
});

test("in the window's two-column step list, a scenario's heading stays in the column of its first step", { timeout: 30_000 }, async () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ui", "watch.html"), "utf8");
  // The shape that split in the self-test: one step, then a new heading that
  // column balancing left at the foot of the first column.
  const scenarios = ["Sign in", "Licence running out", "Licence running out"];
  const steps = scenarios.map((scenario, i) => step(i + 1, i * 1000, i * 1000 + 800, { scenario, intent: `Step ${i + 1} of the session` }));
  const state = { id: "s", title: "Layout", live: false, video: null, speed: "watch", waiting: false, hold: false, next: 0, scenario: null, startedAt: steps[0].startedAt, steps, flags: [2, 3].map((n) => ({ n, kind: "unclear", step: n, time: n, note: `A note on step ${n}`, fixStatus: "sent" })), fix: { pending: null, last: null } };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.route("http://watch.test/**", (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/watch/s") return route.fulfill({ contentType: "text/html", body: html.replace("</head>", `<script>window.__retakeToken="t"</script></head>`) });
      if (u.pathname === "/brand.css") return route.fulfill({ contentType: "text/css", body: fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ui", "brand.css"), "utf8") });
      if (u.pathname === "/api/watch/s/stream") return route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(state)}\n\n` });
      return route.fulfill({ contentType: "application/json", body: "{}" });
    });
    await page.goto("http://watch.test/watch/s");
    await page.waitForFunction((n) => document.querySelectorAll("#steps .m").length === n, steps.length);
    const pairs = await page.evaluate(() => {
      const all = [...document.querySelectorAll("#steps .h, #steps .m")];
      return all.flatMap((el, i) => {
        if (!el.classList.contains("h")) return [];
        const h = el.getBoundingClientRect(), first = all[i + 1].getBoundingClientRect();
        return [{ heading: el.textContent, headingLeft: Math.round(h.left), headingBottom: Math.round(h.bottom), stepLeft: Math.round(first.left), stepTop: Math.round(first.top) }];
      });
    });
    assert.equal(pairs.length, 2);
    for (const p of pairs) {
      assert.ok(Math.abs(p.headingLeft - p.stepLeft) < 40, `“${p.heading}” sits in a different column from its first step`);
      assert.ok(p.stepTop >= p.headingBottom - 2 && p.stepTop - p.headingBottom < 30, `“${p.heading}” is not directly above its first step`);
    }
  } finally { await browser.close(); }
});
