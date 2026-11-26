#!/usr/bin/env node
/**
 * Watch mode, end to end: a tiny local app tested in three steps with a mask,
 * while a second browser sits in the Retake window watching it — the way a
 * person would. Checks the live picture, Unclear + a note, the three speeds,
 * the folder and its video, replay, a timeline flag, and the fix request.
 *
 *   npm run build && node scripts/watch-selftest.mjs [http://localhost:4311]
 *
 * Needs a Retake window running at that address (`retake ui -p 4311`).
 */
import "../dist/browser-home.js";            // Retake's own browser
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startWatch } from "../dist/watch.js";

const UI = process.argv[2] || "http://localhost:4311";
const say = (l) => process.stdout.write(`selftest: ${l}\n`);

const PAGES = {
  "/": `<!doctype html><meta charset="utf-8"><title>Portal</title><body style="font:16px system-ui;padding:40px;background:#fafafa">
    <h1>Client portal</h1>
    <label>Password <input id="password" type="text" value="hunter2-very-secret" style="font-size:20px;padding:6px"></label>
    <p>Authenticator key: <code class="totp-key" style="font-size:22px">JBSWY3DPEHPK3PXP</code></p>
    <a id="go" href="/licences" style="font-size:18px">Licences →</a></body>`,
  "/licences": `<!doctype html><meta charset="utf-8"><title>Licences</title><body style="font:16px system-ui;padding:40px;background:#fafafa">
    <h1>Licences</h1><p>Survey Suite — 1 seat — runs out in 6 days</p>
    <div class="qr" style="width:160px;height:160px;background:repeating-linear-gradient(45deg,#000 0 8px,#fff 8px 16px)"></div>
    <button id="renew" style="font-size:18px;padding:8px 20px;opacity:.45">Renew</button>
    <form id="form" hidden><p>Request: Survey Suite, 1 seat</p></form>
    <script>document.getElementById('renew').onclick=()=>{document.getElementById('form').hidden=false}</script></body>`,
};
const app = http.createServer((req, res) => { const b = PAGES[req.url.split("?")[0]]; res.writeHead(b ? 200 : 404, { "content-type": "text/html" }); res.end(b ?? "no"); });
await new Promise((ok) => app.listen(0, "127.0.0.1", ok));
const APP = `http://127.0.0.1:${app.address().port}`;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const viewer = await (await chromium.launch()).newPage({ viewport: { width: 1280, height: 1000 } });

const w = await startWatch(page, { title: "Self-test – licences", ui: UI, mask: ["#password"] });
assert.ok(w.link, "the window should be reachable");
await page.goto(APP);

// The person opens the window.
await viewer.goto(w.link);
await viewer.waitForSelector("#playpause");
if ((await viewer.getAttribute("#playpause", "aria-pressed")) === "true") await viewer.click("#playpause");   // Play
await viewer.waitForFunction(() => { const i = document.getElementById("live"); return i && i.naturalWidth > 0; }, null, { timeout: 15000 });
say("live picture is streaming");

// 1 — Watch pace: about 1.5 s between steps.
await w.scenario("Sign in");
await w.mask(".totp-key");
await w.step("Check the password is hidden", "The password field is covered");
const hidden = await page.evaluate(() => window.__retakeMask.list());
assert.deepEqual(hidden, ["#password", ".totp-key"]);
await w.result(true, "Password and authenticator key are masked");
let t = Date.now(); await w.beat(); const watchMs = Date.now() - t;
assert.ok(watchMs >= 1300 && watchMs < 4000, `watch pause was ${watchMs} ms`);
say(`watch pace held ${watchMs} ms`);

// 2 — Step: waits for Next. Unclear + a note while it waits.
await w.scenario("L4 Licence running out");
await viewer.click("#playpause");   // Pause: stop at the next step
await w.step("Open Licences", "The licence list, with the one running out");
await page.click("#go");
await page.waitForSelector("#renew");
await w.mask(page.locator(".qr"));
await w.result(true, "Survey Suite runs out in 6 days");
const pressed = (async () => {
  await viewer.waitForSelector("#next.go", { timeout: 10000 });
  await viewer.keyboard.press("u");
  await viewer.waitForFunction(() => document.activeElement?.id === "note");
  await viewer.keyboard.type("Renew looks disabled at 45% opacity");
  await viewer.keyboard.press("Enter");
  await viewer.waitForTimeout(400);
  await viewer.screenshot({ path: path.join(w.dir, "watch-live.png") });
  await viewer.waitForTimeout(800);
  await viewer.click("#next");
})();
t = Date.now(); await w.beat(); const stepMs = Date.now() - t;
await pressed;
assert.ok(stepMs >= 1000, `step mode should wait for Next (waited ${stepMs} ms)`);
say(`step mode waited ${stepMs} ms, for Next`);
const live = JSON.parse(fs.readFileSync(path.join(w.dir, "flags.json"), "utf8"));
assert.equal(live.length, 1);
assert.equal(live[0].source, "live");
assert.equal(live[0].note, "Renew looks disabled at 45% opacity");
assert.equal(live[0].step, 2);
assert.ok(fs.existsSync(path.join(w.dir, live[0].screenshot)));
say("Unclear + note wrote a live flag with a screenshot and the URL " + live[0].url);

// 3 — Play again: the run goes on by itself, with only the short hold.
await viewer.click("#playpause");
await viewer.waitForTimeout(300);
await w.step("Click Renew", "The request form opens, already filled in");
await page.click("#renew");
await page.waitForSelector("#form:not([hidden])");
await w.result(true, "Form pre-filled: Survey Suite, 1 seat");
t = Date.now(); await w.beat(); const playMs = Date.now() - t;
assert.ok(playMs < 4000, `Play should only hold briefly (${playMs} ms)`);
say(`play pace: ${playMs} ms`);
await page.waitForTimeout(600);

const { dir, flags } = await w.end();
for (const f of ["session.mp4", "steps.json", "flags.json", "report.md", "session.json"]) assert.ok(fs.existsSync(path.join(dir, f)), `missing ${f}`);
const steps = JSON.parse(fs.readFileSync(path.join(dir, "steps.json"), "utf8"));
assert.equal(steps.length, 3);
assert.ok(steps.every((s) => s.result === "pass" && s.screenshot && fs.existsSync(path.join(dir, s.screenshot))));
assert.equal(flags.length, 1);
say(`folder written: ${dir}`);

// Replay: the same screen, from the video. 2×, jump to a mark, flag on the timeline.
await viewer.waitForSelector("#vid", { timeout: 15000 });
await viewer.waitForFunction(() => document.getElementById("vid").duration > 0);
await viewer.click('button[data-rate="2"]');
assert.equal(await viewer.evaluate(() => document.getElementById("vid").playbackRate), 2);
await viewer.click(".mark >> nth=2");
await viewer.evaluate(() => document.getElementById("vid").pause());
const at = await viewer.evaluate(() => document.getElementById("vid").currentTime);
assert.ok(Math.abs(at - steps[2].t / 1000) < 0.3, `clicking a mark should jump to its step (at ${at}s)`);
await viewer.keyboard.press("u");
await viewer.keyboard.type("Form fields flash before they fill");
await viewer.keyboard.press("Enter");
await viewer.waitForTimeout(600);
await viewer.evaluate(() => { const v = document.getElementById("vid"); v.currentTime = 2.2; v.pause(); });
await viewer.waitForTimeout(500);
await viewer.screenshot({ path: path.join(dir, "watch-replay.png") });
const all = JSON.parse(fs.readFileSync(path.join(dir, "flags.json"), "utf8"));
const replay = all.find((f) => f.source === "replay");
assert.ok(replay, "a replay flag");
assert.equal(replay.step, 3);
assert.equal(replay.note, "Form fields flash before they fill");
assert.ok(replay.screenshot && fs.existsSync(path.join(dir, replay.screenshot)));
say(`replay flag at ${replay.time}s attached to step ${replay.step}`);

// The notes go out to be fixed after the 10 s undo window.
await viewer.evaluate(() => { const v = document.getElementById("vid"); v.currentTime = v.duration - 0.2; v.play(); });
await viewer.waitForSelector("#undo", { timeout: 15000 });
say("window offers Undo before sending");
await viewer.waitForFunction(() => /Sent 2 notes to fix/.test(document.getElementById("fixline").textContent), null, { timeout: 20000 });
assert.ok(fs.existsSync(path.join(dir, "fix-request.md")) && fs.existsSync(path.join(dir, "fix-request.json")));
const queue = fs.readFileSync(path.join(path.dirname(dir), "fix-queue.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.ok(queue.some((q) => q.dir === dir && q.status === "sent" && q.notes === 2));
say("fix-request.md written and queued");
// A self-test has nothing for a fixer to do: close its request so no agent watching the queue picks it up.
fs.appendFileSync(path.join(path.dirname(dir), "fix-queue.jsonl"), JSON.stringify({ dir, request: "fix-request", notes: 2, at: new Date().toISOString(), status: "done (self-test, nothing to fix)" }) + "\n");

// Leave the person's pace where it starts: Watch.
await viewer.goto(UI + "/watch");
await viewer.evaluate((t) => fetch("/api/watch/speed", { method: "POST", headers: { "content-type": "application/json", "x-retake-token": t }, body: JSON.stringify({ speed: "watch" }) }), await viewer.evaluate(() => window.__retakeToken));
await browser.close(); await viewer.context().browser().close(); app.close();
say(`all good — ${dir}`);
