#!/usr/bin/env node
/**
 * The pictures on the Watch docs page (site/docs/watch.html), made the way a
 * person would see them, against Capture with its public showcase board
 * (test/fixtures/capture/showcase-board.json, the board of Capture's launch
 * demos). Nothing from anyone's real notes can reach a frame: Capture is
 * started here, on its own port, with every account and storage setting
 * blanked and its sync folder a temporary one holding only the showcase.
 *
 *   - Sessions: a real Watch session against Capture, watched in the window.
 *   - Journeys and Nightly: three Capture journeys run twice, the Pricing
 *     thread's summary changed in between, then the list and the changed
 *     journey's screen.
 *   - Adding an app: the window looking around Capture, and its proposals.
 *   - Sending a run: the page `retake watch share` makes.
 *
 *   npm run build && node scripts/watch-docs-shots.mjs
 *   CAPTURE_DIR=~/capture-local (the default)   where Capture's source is
 *
 * Tests never use this: they stay on Larkspur and Fernway (test/fixtures/).
 * Writes site/media/watch-*-v2.{png,jpg}.
 */
import "../dist/browser-home.js";            // Retake's own browser
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startWatch } from "../dist/watch.js";

const deadline = setTimeout(() => { process.stderr.write("shots: gave up after 12 minutes\n"); process.exit(1); }, 720_000);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA = path.join(ROOT, "site", "media");
const SHOWCASE = path.join(ROOT, "test", "fixtures", "capture", "showcase-board.json");
const CAPTURE_DIR = (process.env.CAPTURE_DIR || "~/capture-local").replace(/^~/, os.homedir());
const say = (l) => process.stdout.write(`shots: ${l}\n`);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const waitFor = async (url, ms) => { for (let t = Date.now(); Date.now() - t < ms;) { try { if ((await fetch(url)).ok) return true; } catch { /* not yet */ } await sleep(500); } return false; };

// ---- Capture, on the showcase board and nothing else ----
const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-capture-sync-"));
const capPort = await freePort();
const CAPTURE = `http://localhost:${capPort}`;
let capture = null;
function seed(edit) {
  const board = JSON.parse(fs.readFileSync(SHOWCASE, "utf8"));
  if (edit) edit(board.board);
  fs.writeFileSync(path.join(syncDir, "sync.json"), JSON.stringify(board));
}
async function startCapture() {
  // Blanked, not unset: .env files are read after the process environment, so an
  // explicit "" is what keeps a real token in Capture's own .env.local away.
  capture = spawn("npm", ["run", "dev", "--", "--port", String(capPort)], {
    cwd: CAPTURE_DIR, stdio: "ignore", detached: true,
    env: { ...process.env, APP_PASSWORD: "", UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "", BLOB_READ_WRITE_TOKEN: "", SYNC_DATA_DIR: syncDir },
  });
  assert.ok(await waitFor(CAPTURE + "/app", 180_000), `Capture did not start from ${CAPTURE_DIR}`);
}
async function stopCapture() {
  if (!capture) return;
  try { process.kill(-capture.pid, "SIGTERM"); } catch { /* gone */ }
  capture = null;
  for (let i = 0; i < 40; i++) { try { await fetch(CAPTURE + "/app"); } catch { return; } await sleep(250); }
}
// Capture keeps its board in memory: a new board means a fresh start.
async function restartCapture(edit) { await stopCapture(); seed(edit); await startCapture(); }

// ---- a window of our own, in a workspace of our own ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), "retake-watch-shots-"));
const port = await freePort();
const env = { ...process.env, RETAKE_ROOT: work };
delete env.RETAKE_OUT;
const ui = spawn(process.execPath, [path.join(ROOT, "dist", "cli.js"), "ui", "-p", String(port)], { cwd: work, env, stdio: "ignore" });
const UI = `http://localhost:${port}`;
assert.ok(await waitFor(UI + "/watch", 15_000), "the window did not start");
seed();
await startCapture();
say(`window ${UI}, Capture ${CAPTURE}, workspace ${work}`);

// The helper every Capture journey (and the session below) opens the board with.
const HELPER = `// Shared by the Capture journeys (a file starting with _ is never run on its own).
export const APP = process.env.CAPTURE_URL;
export async function openBoard(page, w, expect = "Three actions, two threads and two intentions") {
  await w.step("Open the board", expect);
  await page.goto(APP + "/app");
  await page.waitForSelector("button.tab:has-text('Intentions 2')", { timeout: 60000 });
  // The board arrives as a sync and says so for a moment; and the dev server's badge is not Capture.
  await page.waitForSelector("div.landed", { state: "detached", timeout: 15000 }).catch(() => {});
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  // The proof it is the showcase and nobody's real notes.
  if (await page.locator("text=I have enough cash flow").count()) throw new Error("not the showcase board");
  await w.result(true, "3 open · 2 threads");
}
`;

// Whatever happens, Capture and the window go with this script.
process.on("exit", () => { try { if (capture) process.kill(-capture.pid, "SIGTERM"); } catch { /* gone */ } try { ui.kill(); } catch { /* gone */ } });
process.on("uncaughtException", (e) => { process.stderr.write(String(e.stack || e) + "\n"); process.exit(1); });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1000, height: 625 }, deviceScaleFactor: 1.6 })).newPage();
const viewer = await (await browser.newContext({ viewport: { width: 1040, height: 1100 }, deviceScaleFactor: 2 })).newPage();
const raw = {};
const box = async (sel) => viewer.locator(sel).first().boundingBox();
const grab = async (name, clip) => { raw[name] = { png: await viewer.screenshot({ clip, fullPage: true }), clip }; say(`captured ${name}`); };
const whole = async () => { const a = await box("#app"); const s = await box("#steps"); return { x: a.x, y: 0, width: a.width, height: s.y + s.height + 28 }; };
const paused = async () => (await viewer.getAttribute("#playpause", "aria-pressed")) === "true";
const play = async () => { if (await paused()) { await viewer.click("#playpause"); await sleep(250); } };
const pause = async () => { if (!(await paused())) { await viewer.click("#playpause"); await sleep(250); } };
const settle = () => sleep(900);                    // the live picture is a frame or two behind the page

// ---- the session ----
fs.mkdirSync(path.join(work, "watch", "capture"), { recursive: true });
fs.writeFileSync(path.join(work, "watch", "capture", "_capture.mjs"), HELPER);
process.env.CAPTURE_URL = CAPTURE;
const { openBoard } = await import(path.join(work, "watch", "capture", "_capture.mjs"));
const w = await startWatch(page, { title: "Capture · Read a thread", ui: UI });
assert.ok(w.link, "the window should be reachable");
// Something plain on screen while the window connects; the board itself loads once, in the first step.
await page.setContent('<html style="background:#f1f0eb"></html>');
await viewer.goto(w.link);
await viewer.waitForFunction(() => { const i = document.getElementById("live"); return i && i.naturalWidth > 0; }, null, { timeout: 30000 });
await play();
await w.scenario("Read a thread");

await openBoard(page, w);
await w.beat();

// A thought typed and taken back, with the box masked: what masking looks like, and nothing is captured.
await w.mask("textarea");
await w.step("Write a thought, masked", "The box is hidden from the stream and the video");
await page.fill("textarea", "a thought nobody else should read");
await settle();
const st = await box("#stage");
await grab("mask", { x: st.x, y: st.y, width: st.width, height: st.height });
await page.fill("textarea", "");
await w.result(true, "Typed, and cleared without capturing");
await w.beat();

await w.step("Open Threads", "Pricing, and what the landing page should promise");
await page.click("button.tab:has-text('Threads')");
await page.waitForSelector("text=What the landing page should promise");
await w.result(true, "2 threads");
await w.beat();

await w.step("Open the Pricing thread", "Where it stands, and what is next");
await page.click("text=Pricing");
await page.waitForSelector("text=Where this stands");
await page.evaluate(() => scrollTo(0, 260));
await w.result(true, "Leaning towards seats; next, a one-page pricing outline");
await Promise.all([w.beat(), (async () => { await settle(); await grab("live", await whole()); })()]);

// Pause: the run stops at the next step, and a note is written there.
await pause();
await w.step("Search the board for “seats”", "The Pricing thread comes up, with the note that matched");
await page.click("text=All threads");
await page.evaluate(() => scrollTo(0, 0));
await page.fill("input[placeholder*='Search']", "seats");
await page.waitForSelector("text=1 note matching");
await w.result(true, "Pricing, 1 note matching");
const noted = (async () => {
  await viewer.waitForSelector("#next.go", { timeout: 15000 });
  await settle();
  await viewer.keyboard.press("u");
  await viewer.waitForFunction(() => document.activeElement?.id === "note");
  await viewer.keyboard.type("Which note matched? Mark the word.", { delay: 12 });
  await sleep(300);
  const s = await box("#stage"), a = await box(".act"), m = await box("#app");
  const top = s.y + s.height * 0.3;
  await grab("note", { x: m.x, y: top, width: m.width, height: a.y + a.height + 22 - top });
  await viewer.keyboard.press("Enter");
  await sleep(500);
  await play();
  await viewer.click("#next");
})();
await Promise.all([w.beat(), noted]);

await w.step("Open Intentions", "The two intentions, each as a sentence about who I am becoming");
await page.fill("input[placeholder*='Search']", "");
await page.click("button.tab:has-text('Intentions')");
await page.waitForSelector("text=ships small things often");
await w.result(true, "2 intentions");
await sleep(1200);
const { dir } = await w.end();
say(`session ${dir}`);

// ---- the replay ----
await viewer.waitForSelector("#vid", { timeout: 20000 });
await viewer.waitForFunction(() => document.getElementById("vid").duration > 0);
// The live note waits ten seconds before it goes; take it back, so both notes go out together.
await viewer.waitForSelector("#undo", { timeout: 15000 });
await viewer.click("#undo");
const steps = JSON.parse(fs.readFileSync(path.join(dir, "steps.json"), "utf8"));
const last = steps.at(-1);
await viewer.evaluate((t) => { const v = document.getElementById("vid"); v.pause(); v.currentTime = t; }, last.t / 1000 + 0.6);
await sleep(500);
await viewer.keyboard.press("u");
await viewer.waitForFunction(() => document.activeElement?.id === "note");
await viewer.keyboard.type("The intentions look alike at a glance. Number them?");
await viewer.keyboard.press("Enter");
await sleep(800);
await viewer.waitForFunction(() => document.querySelectorAll("#track .flag").length === 2);
await viewer.evaluate((t) => { const v = document.getElementById("vid"); v.pause(); v.currentTime = t; }, last.tEnd / 1000 + 0.3);
await viewer.waitForFunction(() => /Passed/.test(document.getElementById("verdict").textContent));
await sleep(900);
await viewer.mouse.move(5, 5);
await grab("replay", await whole());

await viewer.evaluate(() => { const v = document.getElementById("vid"); v.currentTime = Math.max(0, v.duration - 0.3); v.play(); });
await viewer.waitForFunction(() => /Sending 2 notes to fix/.test(document.getElementById("fixline").textContent), null, { timeout: 15000 });
await sleep(1200);
{
  const t = await box("#track"), s = await box("#steps"), m = await box("#app");
  await grab("sending", { x: m.x, y: t.y - 18, width: m.width, height: s.y + s.height + 24 - (t.y - 18) });
}
await viewer.waitForFunction(() => /Sent 2 notes to fix/.test(document.getElementById("fixline").textContent), null, { timeout: 20000 });
say("both notes sent");
const flags = JSON.parse(fs.readFileSync(path.join(dir, "flags.json"), "utf8"));
assert.equal(flags.length, 2);
assert.deepEqual(flags.map((f) => f.source), ["live", "replay"]);
// An example has nothing to fix: close its request so no agent watching the queue picks it up.
fs.appendFileSync(path.join(path.dirname(dir), "fix-queue.jsonl"), JSON.stringify({ dir, request: "fix-request", notes: 2, at: new Date().toISOString(), status: "done (docs example, nothing to fix)" }) + "\n");
const report = fs.readFileSync(path.join(dir, "report.md"), "utf8");

// ---- journeys: two real runs, with the Pricing thread moved on in between ----
const journey = (name, title, body) => fs.writeFileSync(path.join(work, "watch", "capture", `${name}.mjs`), `import { openBoard } from './_capture.mjs';
export const title = ${JSON.stringify(title)};
export const viewport = { width: 1000, height: 625 };
export default async function (page, w) {
  await openBoard(page, w);
${body}
}
`);
journey("read-a-thread", "Read a thread", `  await w.step('Open Threads', 'Pricing, and what the landing page should promise');
  await page.click("button.tab:has-text('Threads')");
  await page.waitForSelector('text=What the landing page should promise');
  await w.result(true, '2 threads');
  await w.step('Open the Pricing thread', 'Where it stands, and what is next');
  await page.click('text=Pricing');
  await page.waitForSelector('text=Where this stands');
  await page.evaluate(() => scrollTo(0, 260));
  await w.result(true, 'Where it stands, and the next step');`);
journey("see-the-actions", "See the actions", `  await w.step('Read the actions', 'Three, each with when it was kept');
  const n = await page.locator('text=Book the dentist before the month turns over').count();
  await w.result(n === 1, '3 actions');`);
journey("see-the-intentions", "See the intentions", `  await w.step('Open Intentions', 'The two intentions, each a sentence about who I am becoming');
  await page.click("button.tab:has-text('Intentions')");
  await page.waitForSelector('text=ships small things often');
  await w.result(true, '2 intentions');`);
fs.writeFileSync(path.join(work, "watch", "capture", "project.json"), JSON.stringify({ name: "Capture" }));
// Capture is a local test copy on the showcase board: a test space.
await viewer.evaluate((origin) => fetch("/api/watch/spaces", { method: "POST", headers: { "content-type": "application/json", "x-retake-token": window.__retakeToken }, body: JSON.stringify({ url: origin, test: true }) }), CAPTURE);
// Not spawnSync: this process is also driving the window, and the runs report to it.
const watchRun = () => new Promise((ok) => {
  const p = spawn(process.execPath, [path.join(ROOT, "dist", "cli.js"), "watch", "run", "capture"], { cwd: work, env: { ...env, RETAKE_UI: UI, CAPTURE_URL: CAPTURE } });
  let stdout = "", stderr = "";
  p.stdout.on("data", (c) => { stdout += c; for (const l of String(c).split("\n")) if (/^[▶✓✗△]/.test(l)) say(`  ${l}`); });
  p.stderr.on("data", (c) => { stderr += c; });
  p.on("close", (status) => ok({ status, stdout, stderr }));
});
let run = await watchRun();
assert.equal(run.status, 0, `the first run keeps each journey as normal:\n${run.stdout}${run.stderr}`);
await restartCapture((b) => { b.threads[0].summary = "Decided on seats: small teams want to know the bill up front. Still open is what the smallest plan costs."; });
run = await watchRun();
assert.equal(run.status, 3, `the second run finds the moved-on thread:\n${run.stdout}${run.stderr}`);
assert.match(run.stdout, /read-a-thread changed at step \d/);
say("journeys run twice; read-a-thread changed");
// The nightly run happens at 03:00, and this script cannot wait for it: put
// each run on the night it would have run, the first a week ago, so the
// window says "last night" and "Unchanged since …" as it would in the morning.
const night = (daysAgo, min) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(3, min, 0, 0); return d.toISOString(); };
const jroot = path.join(work, "watch", ".journeys");
const lasts = [];
for (const [i, name] of fs.readdirSync(jroot).filter((n) => !n.startsWith(".")).sort().entries()) {
  const j = (f) => path.join(jroot, name, f);
  const edit = (f, fn) => { const v = JSON.parse(fs.readFileSync(j(f), "utf8")); fn(v); fs.writeFileSync(j(f), JSON.stringify(v, null, 2)); return v; };
  edit("baseline/snapshots.json", (b) => { b.acceptedAt = night(7, i); });
  lasts.push(edit("last.json", (l) => { l.at = night(0, i); l.scheduled = true; }));
  const runs = fs.readFileSync(j("runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  runs.forEach((r, k) => { r.at = night(k === runs.length - 1 ? 0 : 7, i); r.scheduled = true; });
  fs.writeFileSync(j("runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const { nightlyNotice } = await import("../dist/watch/journey-store.js");
const notice = nightlyNotice(lasts);
assert.ok(notice, "a changed night is not silent");

await viewer.setViewportSize({ width: 1040, height: 760 });
await viewer.goto(UI + "/watch");
await viewer.waitForSelector("ul.cards");
await sleep(600);   // the page fades in
{
  const m = await box(".more");
  await grab("journeys", { x: 0, y: 0, width: 1040, height: m.y + m.height + 30 });
}
await viewer.setViewportSize({ width: 1040, height: 1100 });
await viewer.goto(UI + "/watch/j/read-a-thread");
await viewer.waitForSelector("#accept");
await sleep(1200);
await viewer.mouse.move(5, 5);
{
  const pair = await box(".pair");
  await grab("changed", { x: 0, y: 0, width: 1040, height: pair.y + pair.height + 28 });
}

// ---- sending a run: the page `retake watch share` makes ----
const shared = await viewer.evaluate(() => fetch("/api/watch/share", { method: "POST", headers: { "content-type": "application/json", "x-retake-token": window.__retakeToken }, body: JSON.stringify({ what: "capture" }) }).then((r) => r.json()));
assert.ok(shared.url, `the share was not made: ${JSON.stringify(shared)}`);
const sharePage = await (await browser.newContext({ viewport: { width: 1040, height: 900 }, deviceScaleFactor: 2 })).newPage();
// Opened as the file it is: a share server already running for another workspace would answer that address with its own.
await sharePage.goto("file://" + path.join(work, "outputs", ".shares", "watch-capture", "index.html"));
await sharePage.waitForSelector("#item h2");
await sleep(800);
raw.share = { png: await sharePage.screenshot(), clip: { width: 1040, height: 900 } };
say("captured share");

// ---- adding an app: the window looking around Capture ----
await viewer.setViewportSize({ width: 1040, height: 900 });
await viewer.goto(UI + "/watch/add?url=" + encodeURIComponent(CAPTURE));
await viewer.waitForSelector("ul.picks", { timeout: 240_000 });
await sleep(600);
{
  const a = await box(".add"), b = await box(".btnrow");
  await grab("add", { x: 0, y: Math.max(0, a.y - 40), width: 1040, height: b.y + b.height + 30 - Math.max(0, a.y - 40) });
}

// ---- framing: a plain window on the site's paper, at 2× ----
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const inline = (s) => esc(s).replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a>$1</a>").replace(/`([^`]+)`/g, "<code>$1</code>");
function markdown(md) {
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of md.split("\n")) {
    let m;
    if ((m = /^(#{1,3}) (.*)$/.exec(line))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = /^(?:- |\d+\. )(.*)$/.exec(line))) { const kind = line.startsWith("- ") ? "ul" : "ol"; if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close();
  return out.join("\n");
}
const FRAME_CSS = `
  * { box-sizing: border-box; } html, body { margin: 0; background: transparent; }
  .canvas { display: inline-block; padding: 40px; background: radial-gradient(120% 80% at 10% 0%, #f4eedf 0%, rgba(244,238,223,0) 60%), linear-gradient(160deg, #f7f5ee, #efede4); }
  .win { background: #fffefa; border: 1px solid #d4d3c9; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 2px rgba(37,39,32,.06), 0 22px 44px -24px rgba(37,39,32,.28); }
  .bar { height: 38px; display: flex; align-items: center; gap: 14px; padding: 0 14px; border-bottom: 1px solid #e6e5dd; background: #fffefa; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: #808176; }
  .dots { display: flex; gap: 6px; } .dots i { width: 9px; height: 9px; border-radius: 50%; background: #e3e2d9; border: 1px solid #d4d3c9; }
  .addr { flex: 1; display: flex; justify-content: center; } .addr span { background: #f3f3ed; border-radius: 6px; padding: 4px 14px; min-width: 260px; text-align: center; }
  .pad { width: 40px; }
  .shot { display: block; background: #fbfaf7; }
  .doc { padding: 34px 44px 38px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #252720; width: 860px; background: #fffefa; }
  .doc h1 { font-size: 24px; letter-spacing: -.02em; margin: 0 0 4px; font-weight: 600; }
  .doc h2 { font-size: 17px; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e6e5dd; font-weight: 600; }
  .doc h3 { font-size: 14px; margin: 18px 0 6px; color: #72736b; font-weight: 600; }
  .doc p { margin: 6px 0; color: #4b4d44; } .doc ul, .doc ol { margin: 6px 0; padding-left: 22px; } .doc li { margin: 6px 0; }
  .doc a { color: #8a601e; text-decoration: underline; text-underline-offset: 2px; }
  .canvas.loose { padding: 64px 96px; }
  .notice { width: 440px; display: flex; gap: 12px; align-items: flex-start; padding: 13px 16px 14px 13px; border-radius: 18px; background: rgba(255,254,250,.94); border: 1px solid #e3e2d9;
    box-shadow: 0 1px 2px rgba(37,39,32,.06), 0 18px 36px -18px rgba(37,39,32,.3); font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #252720; }
  .notice .icon svg { width: 38px; height: 38px; display: block; }
  .notice .txt { flex: 1; min-width: 0; }
  .notice .top { display: flex; justify-content: space-between; gap: 12px; margin: 1px 0 2px; }
  .notice .top b { font-weight: 600; } .notice .top span { color: #8a8b82; font-size: 12px; }
  .notice .body { display: block; color: #3d3f37; }
  .doc code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f3ed; padding: 1px 5px; border-radius: 3px; }`;
const framer = await (await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })).newPage();
async function frame(name, address, inner, type = "png") {
  const body = address === null ? `<div class="canvas loose">${inner}</div>`
    : `<div class="canvas"><div class="win"><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="addr"><span>${esc(address)}</span></span><span class="pad"></span></div>${inner}</div></div>`;
  await framer.setContent(`<!doctype html><meta charset="utf-8"><style>${FRAME_CSS}</style>${body}`);
  await framer.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  // Pictures with the live page in them are photographs, as far as a file format is concerned: JPEG, a third the size.
  const file = path.join(MEDIA, `watch-${name}-v2.${type === "jpeg" ? "jpg" : "png"}`);
  await framer.locator(".canvas").screenshot({ path: file, type, ...(type === "jpeg" ? { quality: 90 } : {}) });
  say(`wrote ${path.relative(ROOT, file)}`);
}
const shot = (name) => `<img class="shot" src="data:image/png;base64,${raw[name].png.toString("base64")}" width="${Math.round(raw[name].clip.width)}" height="${Math.round(raw[name].clip.height)}" alt="">`;
const where = "localhost:4310/watch";
await frame("live", where, shot("live"), "jpeg");
await frame("note", where, shot("note"), "jpeg");
await frame("replay", where, shot("replay"), "jpeg");
await frame("sending", where, shot("sending"));
await frame("mask", where, shot("mask"), "jpeg");
await frame("report", "report.md", `<article class="doc">${markdown(report)}</article>`);
await frame("journeys", where, shot("journeys"));
await frame("changed", "localhost:4310/watch/j/read-a-thread", shot("changed"), "jpeg");
await frame("add", "localhost:4310/watch/add", shot("add"));
await frame("share", "localhost:4790/watch-capture/", shot("share"), "jpeg");
// The notification is drawn, not an operating system's: the words are the ones the nightly run sends.
const mark = fs.readFileSync(path.join(ROOT, "site", "favicon.svg"), "utf8");
await frame("notice", null, `<div class="notice"><span class="icon">${mark}</span><span class="txt"><span class="top"><b>${esc(notice.title)}</b><span>3:04</span></span><span class="body">${esc(notice.body)}</span></span></div>`);

// The window, its workspace and Capture were ours: close them.
await browser.close();
ui.kill();
await stopCapture();
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(syncDir, { recursive: true, force: true });
clearTimeout(deadline);
say("done");
process.exit(0);
