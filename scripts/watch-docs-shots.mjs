#!/usr/bin/env node
/**
 * The pictures on the Watch mode docs page (site/docs/watch.html), made the
 * way a person would see them: a real Watch session against Larkspur, a
 * made-up room-booking app (test/fixtures/larkspur/), watched in the real
 * /watch window, then framed for the site.
 *
 *   npm run build && node scripts/watch-docs-shots.mjs
 *
 * It starts its own Retake window in a temporary workspace, so nothing lands
 * in this repo's outputs/ and the person's pace is left alone. Writes
 * site/media/watch-*-v2.png.
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
import { serveLarkspur } from "../test/fixtures/larkspur/serve.mjs";

const deadline = setTimeout(() => { process.stderr.write("shots: gave up after 4 minutes\n"); process.exit(1); }, 240_000);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA = path.join(ROOT, "site", "media");
const say = (l) => process.stdout.write(`shots: ${l}\n`);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

// ---- a window of our own, in a workspace of our own ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), "retake-watch-shots-"));
const port = await freePort();
const env = { ...process.env, RETAKE_ROOT: work };
delete env.RETAKE_OUT;
const ui = spawn(process.execPath, [path.join(ROOT, "dist", "cli.js"), "ui", "-p", String(port)], { cwd: work, env, stdio: "ignore" });
const UI = `http://localhost:${port}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(UI + "/watch")).ok) break; } catch { /* not yet */ } await sleep(250); }

const { server: app, url: APP } = await serveLarkspur(await new Promise((ok) => { const s = net.createServer().once("error", () => ok(0)).listen(4471, "127.0.0.1", () => s.close(() => ok(4471))); }));
say(`window ${UI}, app ${APP}, workspace ${work}`);

const browser = await chromium.launch();
// 1.6× makes the page exactly the size of the live picture (1600 × 1000), so no frame is scaled down.
const page = await (await browser.newContext({ viewport: { width: 1000, height: 625 }, deviceScaleFactor: 1.6 })).newPage();
const viewer = await (await browser.newContext({ viewport: { width: 1040, height: 1100 }, deviceScaleFactor: 2 })).newPage();
const raw = {};
const box = async (sel) => viewer.locator(sel).first().boundingBox();
const grab = async (name, clip) => { raw[name] = { png: await viewer.screenshot({ clip }), clip }; say(`captured ${name}`); };
const whole = async () => { const a = await box("#app"); const s = await box("#steps"); return { x: a.x, y: 0, width: a.width, height: s.y + s.height + 28 }; };
const speed = async (s) => { await viewer.click(`button[data-speed="${s}"]`); await sleep(250); };
const settle = () => sleep(900);                    // the live picture is a frame or two behind the page

// ---- the session ----
const w = await startWatch(page, { title: "Larkspur · Book a room", ui: UI, mask: ["#password"] });
assert.ok(w.link, "the window should be reachable");
await page.goto(APP + "/");
await viewer.goto(w.link);
await viewer.waitForFunction(() => { const i = document.getElementById("live"); return i && i.naturalWidth > 0; }, null, { timeout: 15000 });
await speed("watch");
await w.scenario("Book a room");

await w.step("Sign in as Maya", "The Today page opens");
await page.fill("#email", "maya@corvidlane.example");
await page.fill("#password", "correct-horse-battery");
await settle();
const st = await box("#stage");
await grab("mask", { x: st.x, y: st.y, width: st.width, height: st.height });
await page.click("button[type=submit]");
await page.waitForURL("**/today");
await w.result(true, "Signed in, and Today shows her next booking");
await w.beat();

await w.step("Open Rooms", "All nine rooms, with what is free now");
await page.click(".nav a[href='/rooms']");
await page.waitForSelector(".room");
await w.result(true, "9 rooms listed");
await w.beat();

await w.step("Show rooms for six or more", "The list narrows to the bigger rooms");
await page.click(".chip[data-min='6']");
await w.result((await page.locator(".room").count()) === 5, "5 rooms seat six or more");
await w.beat();

await w.step("Open Juniper", "The page for Juniper, with today’s schedule");
await page.click("[data-room=juniper]");
await page.waitForSelector("#book");
await w.result(true, "Free from 14:00 to 16:00");
await Promise.all([w.beat(), (async () => { await settle(); await grab("live", await whole()); })()]);

await w.step("Press Book Juniper", "The booking form opens with Juniper filled in");
await page.click("#book");
await page.waitForSelector("#form");
await w.result(true, "Form open, with the room filled in");
await w.beat();

await speed("step");
await w.step("Fill in a design review, 14:00 to 15:00", "Title, time and guests are filled in");
await page.fill("#title", "Design review");
await page.selectOption("#end", "15:00");
await page.fill("#people", "Sam Kade, Jo Reyes");
await w.result(true, "Design review, 14:00 – 15:00, 2 guests");
const noted = (async () => {
  await viewer.waitForSelector("#next.go", { timeout: 15000 });
  await settle();
  await viewer.keyboard.press("u");
  await viewer.waitForFunction(() => document.activeElement?.id === "note");
  await viewer.keyboard.type("Which time zone are these times in? The form doesn’t say.", { delay: 12 });
  await sleep(300);
  const s = await box("#stage"), a = await box(".act"), m = await box("#app");
  const top = s.y + s.height * 0.3;
  await grab("note", { x: m.x, y: top, width: m.width, height: a.y + a.height + 22 - top });
  await viewer.keyboard.press("Enter");
  await sleep(500);
  await speed("watch");
  await viewer.click("#next");
})();
await Promise.all([w.beat(), noted]);

await w.step("Save the booking", "Your bookings opens, with the new one");
await page.click("#save");
await page.waitForURL("**/bookings");
await w.result(true, "Saved, and Bookings shows 5 coming up");
await w.beat();

await w.step("Find the new booking", "The design review at 14:00 in Juniper, marked as new");
const fresh = page.locator(".booking.is-new");
await w.result((await fresh.count()) === 1 && /Design review/.test(await fresh.innerText()), "Listed at 14:00, with a New tag");
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
await viewer.keyboard.type("The new booking only gets a small grey tag. Easy to miss.");
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
const flags = JSON.parse(fs.readFileSync(path.join(dir, "flags.json"), "utf8"));
assert.equal(flags.length, 2);
assert.deepEqual(flags.map((f) => f.source), ["live", "replay"]);
// An example has nothing to fix: close its request so no agent watching the queue picks it up.
fs.appendFileSync(path.join(path.dirname(dir), "fix-queue.jsonl"), JSON.stringify({ dir, request: "fix-request", notes: 2, at: new Date().toISOString(), status: "done (docs example, nothing to fix)" }) + "\n");
const report = fs.readFileSync(path.join(dir, "report.md"), "utf8");

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
  .shot { display: block; background: #f6f6f3; }
  .doc { padding: 34px 44px 38px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #252720; width: 860px; background: #fffefa; }
  .doc h1 { font-size: 24px; letter-spacing: -.02em; margin: 0 0 4px; font-weight: 600; }
  .doc h2 { font-size: 17px; margin: 26px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #e6e5dd; font-weight: 600; }
  .doc h3 { font-size: 14px; margin: 18px 0 6px; color: #72736b; font-weight: 600; }
  .doc p { margin: 6px 0; color: #4b4d44; } .doc ul, .doc ol { margin: 6px 0; padding-left: 22px; } .doc li { margin: 6px 0; }
  .doc a { color: #8a601e; text-decoration: underline; text-underline-offset: 2px; }
  .doc code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f3ed; padding: 1px 5px; border-radius: 3px; }`;
const framer = await (await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })).newPage();
async function frame(name, address, inner, type = "png") {
  await framer.setContent(`<!doctype html><meta charset="utf-8"><style>${FRAME_CSS}</style><div class="canvas"><div class="win"><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="addr"><span>${esc(address)}</span></span><span class="pad"></span></div>${inner}</div></div>`);
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

// The window, its workspace and the app were ours: close them.
await browser.close();
ui.kill();
app.close();
fs.rmSync(work, { recursive: true, force: true });
clearTimeout(deadline);
say("done");
