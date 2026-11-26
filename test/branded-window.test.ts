/* The branded window: projects, names in words, Next in the list's order,
   the theme button, the paced replay, the page you send someone, and Undo
   that takes a note back. Pages are loaded from src/ui as the window serves
   them; the API answers come from the real routes or a stand-in. */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium, type Route } from "playwright";
import { listJourneys, pickJourneys, writeRun, type RunRecord } from "../src/watch/journey-store.js";
import { groupName, hostName } from "../src/watch/names.js";
import { listProjects, projectForSite, projectOfJourney, siteKey } from "../src/watch/projects.js";
import { buildWatchShare, watchSharePage, type WatchShareItem } from "../src/watch/share.js";
import { appendFlag, readFlagsIn, writeMeta } from "../src/watch/session.js";
import { watchRoutes } from "../src/ui/watch-routes.js";
import { ffmpegBin } from "../src/media-bin.js";

const UI = path.join(import.meta.dirname, "..", "src", "ui");
const read = (f: string) => fs.readFileSync(path.join(UI, f), "utf8");
const workspace = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "retake-brand-")); fs.mkdirSync(path.join(d, "watch"), { recursive: true }); return d; };
const journey = (root: string, rel: string, src = "export default async () => {};\n") => { const f = path.join(root, "watch", rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, src); };
const ask = (routes: ReturnType<typeof watchRoutes>) => async (p: string, method = "GET", payload: unknown = {}) => {
  let body = "", code = 0;
  const res = { headersSent: false, writeHead: (c: number) => { code = c; }, end: (b?: string) => { body = b ?? ""; } } as unknown as http.ServerResponse;
  const u = new URL(p, "http://x");
  await routes.handleApi({ method } as http.IncomingMessage, res, u, u.pathname, async () => JSON.stringify(payload));
  return { code, json: JSON.parse(body || "null") };
};

// ---------- names, sites and projects ----------

test("a group is named in words: the shared start of its titles, else the app's address", () => {
  const g = groupName(["Shop – checkout: pay by card", "Shop – account: change the address"], "127.0.0.1:8080");
  assert.equal(g.name, "Shop");
  assert.equal(g.short("Shop – checkout: pay by card"), "Checkout: pay by card");
  const s = groupName(["Sign-in screens", "Sign-in screens, on a phone"], "login.example.com");
  assert.equal(s.name, "Sign-in screens");
  assert.equal(s.short("Sign-in screens, on a phone"), "On a phone");
  assert.equal(groupName(["Book a room", "Your bookings"], "larkspur.localhost:4471").name, "Larkspur");
  assert.equal(hostName("127.0.0.1:8080"), null);
});

test("a site is its registrable domain; a local address is its own", () => {
  assert.equal(siteKey("login.example-shop.com"), "example-shop.com");
  assert.equal(siteKey("portal.example-shop.com"), "example-shop.com");
  assert.equal(siteKey("shop.example.co.uk"), "example.co.uk");
  assert.equal(siteKey("127.0.0.1:8080"), "127.0.0.1:8080");
  assert.equal(siteKey("larkspur.localhost:4471"), "larkspur.localhost:4471");
});

test("a project is a folder under watch/; journeys directly in watch/ group by site, so nothing has to move", () => {
  const root = workspace();
  journey(root, "acme/portal.mjs", `export const url = "https://portal.example.com";\nexport default async () => {};\n`);
  journey(root, "acme/_helper.mjs");
  fs.writeFileSync(path.join(root, "watch", "acme", "project.json"), JSON.stringify({ name: "ACME" }));
  journey(root, "larkspur/book.mjs");
  journey(root, "login.mjs", `export const url = "https://login.example.org";\nexport default async () => {};\n`);
  journey(root, "www.mjs", `export const url = "https://www.example.org/x";\nexport default async () => {};\n`);
  const all = listJourneys(root);
  assert.deepEqual(all.map((j) => j.name), ["book", "login", "portal", "www"]);
  const projects = listProjects(root);
  assert.deepEqual(projects.map((p) => [p.id, p.name, p.journeys]), [["acme", "ACME", ["portal"]], ["example", "Example", ["login", "www"]], ["larkspur", "Larkspur", ["book"]]]);
  // `retake watch run <project>` runs a project's journeys.
  const of = (j: { name: string }) => projectOfJourney(projects, j.name)?.id ?? "";
  assert.deepEqual(pickJourneys(all, "example", of).map((j) => j.name), ["login", "www"]);
  assert.deepEqual(pickJourneys(all, "acme", of).map((j) => j.name), ["portal"]);
  assert.equal(pickJourneys(all, "all", of).length, 4);
  // A new app on a site a project already watches goes there; otherwise a new project, named after it.
  assert.equal(projectForSite(root, "https://help.example.com").existing?.id, "acme");
  assert.equal(projectForSite(root, "https://fernway.test").existing, null);
  assert.equal(projectForSite(root, "https://fernway.test").fresh.name, "Fernway");
});

// ---------- the list's order, which Next walks ----------

const run = (root: string, name: string, status: RunRecord["status"], over: Partial<RunRecord> = {}) => {
  const dir = path.join(root, "outputs", "watch", `${name}-run`);
  fs.mkdirSync(dir, { recursive: true });
  writeMeta(dir, { id: `${name}-run`, title: name, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), video: null });
  fs.writeFileSync(path.join(dir, "steps.json"), "[]");
  writeRun(root, { journey: name, title: name, at: new Date().toISOString(), session: `${name}-run`, dir, status, scheduled: false, error: null, steps: 1, changes: [], ...over });
};

test("Next walks the project in the list's order: what needs a look first, then the rest; the last has none", async () => {
  const root = workspace();
  for (const n of ["a-fine", "b-changed", "c-failed", "d-fine"]) journey(root, `shop/${n}.mjs`);
  run(root, "a-fine", "unchanged"); run(root, "b-changed", "changed"); run(root, "c-failed", "failed"); run(root, "d-fine", "unchanged");
  const routes = watchRoutes({ root, outRoot: () => path.join(root, "outputs"), token: "t", activity: () => {} });
  const J = (await ask(routes)("/api/watch/journeys")).json;
  assert.equal(J.project, "shop");
  assert.deepEqual(J.order.map((o: { name: string }) => o.name), ["c-failed", "b-changed", "a-fine", "d-fine"]);
  const first = (await ask(routes)("/api/watch/order?journey=c-failed")).json;
  assert.deepEqual([first.at, first.total, first.next, first.lastLoud], [1, 4, "/watch/j/b-changed", false]);
  const lastLoud = (await ask(routes)("/api/watch/order?journey=b-changed")).json;
  assert.equal(lastLoud.lastLoud, true, "after the last one needing a look, the page says nothing else does");
  assert.equal(lastLoud.next, "/watch/a-fine-run");
  const end = (await ask(routes)("/api/watch/order?session=d-fine-run")).json;
  assert.deepEqual([end.at, end.next], [4, null]);
});

test("Undo takes a note back: the flag is gone; one already sent to be fixed stays", async () => {
  const root = workspace();
  const out = path.join(root, "outputs");
  const dir = path.join(out, "watch", "s1");
  fs.mkdirSync(dir, { recursive: true });
  writeMeta(dir, { id: "s1", title: "S", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), video: null });
  fs.writeFileSync(path.join(dir, "steps.json"), "[]");
  const f = appendFlag(dir, { kind: "note", step: null, time: 0, at: new Date().toISOString(), note: "x", screenshot: null, url: "", source: "replay" });
  const sent = appendFlag(dir, { kind: "note", step: null, time: 0, at: new Date().toISOString(), note: "y", screenshot: null, url: "", source: "replay", fix: "fix-request" });
  const routes = watchRoutes({ root, outRoot: () => out, token: "t", activity: () => {} });
  assert.equal((await ask(routes)("/api/watch/s1/flag/remove", "POST", { n: f.n })).code, 200);
  assert.equal((await ask(routes)("/api/watch/s1/flag/remove", "POST", { n: sent.n })).code, 409);
  assert.deepEqual(readFlagsIn(dir).map((x) => x.n), [sent.n]);
});

// ---------- in a browser ----------

const browser = await chromium.launch({ headless: true });
test.after(() => browser.close());
const files: Record<string, [string, string]> = { "/brand.css": ["text/css", read("brand.css")], "/brand.js": ["text/javascript", read("brand.js")] };
const serveWindow = (api: (u: URL) => unknown) => async (route: Route) => {
  const u = new URL(route.request().url());
  if (files[u.pathname]) return route.fulfill({ contentType: files[u.pathname][0], body: files[u.pathname][1] });
  if (u.pathname.startsWith("/watch")) return route.fulfill({ contentType: "text/html", body: read("watch.html").replace("</head>", `<script>window.__retakeToken="t"</script></head>`) });
  return route.fulfill({ contentType: "application/json", body: JSON.stringify(api(u) ?? {}) });
};

test("the theme: System follows the Mac; Light and Dark override it, and the choice survives a reload", async () => {
  const ctx = await browser.newContext({ colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.route("http://w.test/**", serveWindow(() => ({ journeys: [], projects: [] })));
  const paper = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim());
  const label = () => page.getAttribute("#theme", "aria-label");
  await page.goto("http://w.test/watch/sessions");
  assert.equal(await label(), "Theme: System");
  assert.equal(await paper(), "#151512", "System on a dark Mac is dark");
  await page.click("#theme");
  assert.equal(await label(), "Theme: Light");
  assert.equal(await paper(), "#fbfaf7");
  await page.reload();
  assert.equal(await label(), "Theme: Light", "remembered");
  assert.equal(await paper(), "#fbfaf7", "applied before paint, from localStorage");
  await page.click("#theme");
  assert.equal(await label(), "Theme: Dark");
  await page.click("#theme");
  assert.equal(await label(), "Theme: System");
  await page.emulateMedia({ colorScheme: "light" });
  assert.equal(await paper(), "#fbfaf7", "System follows prefers-color-scheme");
  await page.emulateMedia({ colorScheme: "dark" });
  assert.equal(await paper(), "#151512");
  await ctx.close();
});

test("on a journey's page, → is Next, except while typing", async () => {
  const page = await browser.newPage();
  await page.route("http://w.test/**", serveWindow((u) => u.pathname === "/api/watch/order" ? { at: 2, total: 5, next: "/watch/j/after", lastLoud: true, project: "p" }
    : u.pathname.startsWith("/api/watch/journeys/") ? { name: "here", title: "Here", line: "Changed today at 09:00", status: "changed", session: null, moment: null, steps: 0 } : { journeys: [], projects: [] }));
  await page.goto("http://w.test/watch/j/here");
  await page.waitForSelector("#nextJourney");
  assert.equal(await page.textContent(".pager .count"), "2 of 5");
  assert.equal(await page.textContent(".pager .quietline"), "Nothing else needs a look");
  assert.ok(!(await page.getAttribute("#nextJourney", "class"))!.includes("go"), "the page's own action is the ink button; Next is quiet");
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "typing"; document.body.append(i); });
  await page.focus("#typing");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  assert.equal(new URL(page.url()).pathname, "/watch/j/here", "typing → stays put");
  await page.focus("body");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await Promise.all([page.waitForURL("**/watch/j/after"), page.keyboard.press("ArrowRight")]);
  await page.close();
});

test("Play holds about 1.5 s at each step's end, on the video's own clock; Pause during a hold stops there", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-pace-"));
  const video = path.join(dir, "v.webm");
  const r = spawnSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=3:size=160x90:rate=25", "-c:v", "libvpx", "-b:v", "100k", video]);
  assert.equal(r.status, 0, String(r.stderr));
  const pacer = /<script id="pacer">([\s\S]*?)<\/script>/.exec(read("watch.html"))![1];
  const page = await browser.newPage();
  await page.route("http://p.test/**", (route) => route.request().url().endsWith(".webm")
    ? route.fulfill({ contentType: "video/webm", body: fs.readFileSync(video) })
    : route.fulfill({ contentType: "text/html", body: `<video id="v" muted playsinline preload="auto" src="/v.webm"></video><script>${pacer}</script>` }));
  await page.goto("http://p.test/");
  // Three steps ending at 0.8 s, 1.6 s and 2.4 s of a 3 s video.
  // A string, not a function: tsx would add a helper the page does not have.
  const wall = () => page.evaluate(`new Promise((done) => {
    const v = document.getElementById("v");
    v.currentTime = 0;
    let holds = 0;
    const steps = [{ t: 0, tEnd: 800 }, { t: 900, tEnd: 1600 }, { t: 1700, tEnd: 2400 }];
    pacer(v, () => steps, { onHold: (on) => { if (on) holds++; } });
    const start = performance.now();
    v.addEventListener("ended", () => done({ ms: performance.now() - start, holds, t: v.currentTime }), { once: true });
    v.play();
  })`) as Promise<{ ms: number; holds: number; t: number }>;
  const play = await wall();
  assert.equal(play.holds, 3);
  assert.ok(play.ms > 3000 + 3 * 1500 - 600 && play.ms < 3000 + 3 * 1500 + 1500, `Play took ${Math.round(play.ms)} ms`);
  assert.ok(Math.abs(play.t - 3) < 0.2, "the video's own clock is untouched");
  // Pause while it holds: it stays stopped, and Play goes on from there.
  await page.reload();
  const stopped = await page.evaluate(`new Promise((done) => {
    const v = document.getElementById("v");
    const p = pacer(v, () => [{ t: 0, tEnd: 500 }], { onHold: (on) => { if (on) { p.toggle(); setTimeout(() => done({ paused: v.paused, playing: p.playing(), t: v.currentTime }), 2200); } } });
    v.play();
  })`) as { paused: boolean; playing: boolean; t: number };
  assert.equal(stopped.paused, true);
  assert.equal(stopped.playing, false, "a Pause during a hold is not undone when the hold ends");
  assert.ok(stopped.t < 1);
  await page.close();
});

test("the page you send: one thing at a time, Next and its count, the place kept in the address", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-share-"));
  const item = (kind: WatchShareItem["kind"], title: string): WatchShareItem => ({ kind, title, short: title, group: kind === "fine" ? "Shop" : null, line: kind === "fine" ? "Unchanged since 3 Dec" : "Failed today at 09:00", reason: kind === "fine" ? null : "“Pay” failed: no total.", pictures: [], video: null, poster: null, start: 0, steps: [{ n: 1, scenario: null, intent: "Pay", expect: "A total", result: kind === "fine" ? "pass" : "fail", note: "", t: 0, tEnd: 500 }], notes: [] });
  fs.writeFileSync(path.join(dir, "index.html"), watchSharePage({ title: "1 journey failed today", items: [item("failed", "Checkout"), item("fine", "Browse"), item("fine", "Search")] }));
  const page = await browser.newPage();
  await page.goto("file://" + path.join(dir, "index.html") + "#2");
  assert.equal(await page.textContent("#count"), "2 of 3");
  assert.equal(await page.textContent("#item h2"), "Browse");
  await page.click("#next");
  assert.equal(await page.textContent("#count"), "3 of 3");
  assert.ok(page.url().endsWith("#3"));
  assert.equal(await page.isDisabled("#next"), true, "the last has no Next");
  await page.goto("file://" + path.join(dir, "index.html") + "#1");
  await page.waitForFunction(() => document.getElementById("count")!.textContent === "1 of 3");
  assert.equal(await page.textContent("#quiet"), "Nothing else needs a look");
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "t"; document.body.append(i); });
  await page.focus("#t"); await page.keyboard.press("ArrowRight");
  assert.equal(await page.textContent("#count"), "1 of 3", "→ while typing does nothing");
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.textContent("#count"), "2 of 3");
  // The list is always there on a wide screen: every journey is one click away.
  assert.equal(await page.isVisible("#list"), true);
  assert.deepEqual(await page.$$eval("#list p", (ps) => ps.map((p) => p.textContent)), ["Needs a look", "Shop"]);
  await page.click('#list button[data-i="2"]');
  assert.equal(await page.textContent("#count"), "3 of 3");
  assert.ok(page.url().endsWith("#3"));
  assert.equal(await page.getAttribute('#list button[data-i="2"]', "aria-current"), "true");
  // ↑ and ↓ move through it while it has the focus.
  await page.focus('#list button[data-i="2"]');
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.textContent("#count"), "2 of 3");
  // On a phone the same list is a sheet, opened from "2 of 3 · All ▾".
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => getComputedStyle(document.getElementById("list")!).visibility === "hidden", null, { timeout: 3000 });
  assert.equal(await page.textContent("#all"), "2 of 3 · All ▾");
  await page.click("#all");
  await page.waitForFunction(() => getComputedStyle(document.getElementById("list")!).visibility === "visible");
  await page.click('#list button[data-i="0"]');
  assert.equal(await page.textContent("#count"), "1 of 3");
  await page.waitForFunction(() => !document.body.classList.contains("sheet"));
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.ok(!/retakeToken|x-retake-token|localhost:43|password/i.test(html), "no token, no window address, no sign-in");
  assert.ok(!/id="theme"/.test(html), "it follows the viewer's own theme: no button");
  await page.close();
});

test("a share of a project holds only its runs' videos, pictures and words, and leaves notes out unless asked", () => {
  const root = workspace();
  journey(root, "shop/pay.mjs");
  run(root, "pay", "failed", { error: "no saved login for shop.example.com — run `retake login https://shop.example.com` once, with the test account's e-mail, password and authenticator key" });
  const dir = path.join(root, "outputs", "watch", "pay-run");
  appendFlag(dir, { kind: "note", step: 1, time: 0, at: new Date().toISOString(), note: "a private note", screenshot: null, url: "", source: "replay" });
  const s = buildWatchShare({ root, outRoot: path.join(root, "outputs"), what: "shop" });
  const html = fs.readFileSync(path.join(s.dir, "index.html"), "utf8");
  assert.equal(s.name, "watch-shop");
  assert.ok(html.includes("There is no saved sign-in for shop.example.com."));
  assert.ok(!html.includes("retake login"), "the command meant for the person is not on the page");
  assert.ok(!html.includes("a private note"));
  const withNotes = buildWatchShare({ root, outRoot: path.join(root, "outputs"), what: "shop", notes: true });
  assert.ok(fs.readFileSync(path.join(withNotes.dir, "index.html"), "utf8").includes("a private note"));
  assert.deepEqual(fs.readdirSync(s.dir).sort(), ["index.html", "v"]);
});

test("a name is never made of small words, and a title that does not start with it is left whole", () => {
  const g = groupName(["See the actions", "See the intentions"], null);
  assert.notEqual(g.name, "See the");
  assert.equal(g.short("Read a thread"), "Read a thread");
  const s = groupName(["Sign-in screens", "Sign-in screens, on a phone"], null);
  assert.equal(s.short("Read a thread"), "Read a thread");
});
