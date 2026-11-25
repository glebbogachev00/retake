/** What a real seventeen-journey suite found wrong with Watch, each pinned:
    a one-pixel reflow is not a change; a mask holds at the moment of capture;
    a journey with one failing step still compares the rest; a failure names
    its step; the list lines up and groups by app; a run going on does not
    hide the list; a run finds this workspace's window; a journey gets its
    app's address; and adding an app twice, or without its test account,
    does not go wrong. */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pictureDiff, SHIFT_TOLERANCE, type Picture } from "../src/watch/compare.js";
import { failureLine, readBaseline, type RunRecord } from "../src/watch/journey-store.js";
import { runJourney } from "../src/watch/journeys.js";
import { readWindow, writeWindow, clearWindow } from "../src/ui/guard.js";
import { addJourneys, type Suggestion } from "../src/watch/suggest.js";
import { alreadyWatched } from "../src/watch/spaces.js";
import { watchRoutes } from "../src/ui/watch-routes.js";
// @ts-expect-error — a plain .mjs fixture
import { startFernway, ACCOUNT } from "./fixtures/fernway/serve.mjs";

const workspace = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "retake-edges-")); fs.mkdirSync(path.join(d, "watch")); return d; };
const blank = (w: number, h: number, v = 255): Picture => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) });
const paint = (p: Picture, x0: number, y0: number, w: number, h: number, v = 0) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const o = (y * p.width + x) * 4; p.data[o] = p.data[o + 1] = p.data[o + 2] = v; }
  return p;
};
/** A line of "text": glyph-like strokes, starting at x. */
const line = (p: Picture, x: number, y: number, glyphs = 24) => {
  for (let g = 0; g < glyphs; g++) { const gx = x + g * 9; paint(p, gx, y, 2, 12); paint(p, gx + 2, y, 4, 2); paint(p, gx + 2, y + 5, 3, 2); paint(p, gx + 2, y + 10, 4, 2); }
  return p;
};

// ---------- 1. a pixel of reflow is not a change ----------

test("text that moved by one pixel is unchanged; a word replaced or an icon gone still is a change", () => {
  assert.equal(SHIFT_TOLERANCE, 1);
  const before = line(line(blank(260, 80), 10, 10), 10, 40);
  // A masked clock got a digit narrower: everything after it moved one pixel left, and one down.
  assert.equal(pictureDiff(before, line(line(blank(260, 80), 9, 10), 9, 40)).changed, false, "a 1 px shift left is not a change");
  assert.equal(pictureDiff(before, line(line(blank(260, 80), 10, 11), 10, 41)).changed, false, "a 1 px shift down is not a change");
  assert.equal(pictureDiff(before, line(line(blank(260, 80), 11, 9), 11, 39)).changed, false, "nor diagonally");
  // A real change: the second line's words are different shapes (solid blocks).
  const reworded = line(blank(260, 80), 10, 10);
  for (let g = 0; g < 24; g++) paint(reworded, 10 + g * 9, 40, 7, 12);
  assert.equal(pictureDiff(before, reworded).changed, true, "different words are a change");
  // An icon gone, even next to a 1 px shift.
  const icon = paint(line(blank(260, 80), 10, 10), 200, 50, 24, 24);
  assert.equal(pictureDiff(icon, line(blank(260, 80), 9, 10)).changed, true, "the icon going is still seen");
  // A one-pixel rule drawn across the page is a change too.
  const ruled = line(line(blank(260, 80), 10, 10), 10, 40);
  paint(ruled, 0, 70, 260, 1);
  assert.equal(pictureDiff(before, ruled).changed, true, "a new 1 px line is a change");
});

// ---------- a page that changes under the journeys ----------

function site() {
  const state = { greeting: "Welcome back", step2: false };
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // Whether it is ready shows on its own page, so it moves nothing else.
    if (req.url === "/ready") return void res.end(`<!doctype html><html><body style="font:16px sans-serif;margin:20px"><p id="ok">${state.step2 ? "Ready" : "Not ready"}</p></body></html>`);
    res.end(`<!doctype html><html><body style="font:16px sans-serif;margin:20px">
<h1>${state.greeting}</h1>
<button id="stamp" onclick="const s=document.createElement('span');s.className='when';s.textContent='Updated 10:42:17';document.body.appendChild(s)">Stamp</button>
</body></html>`);
  });
  return new Promise<{ url: string; state: typeof state; close: () => void }>((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, state, close: () => server.close() })));
}

// ---------- 2. masks hold at the moment of capture; 9. the kit has the app's address ----------

test("a masked thing that appears just before a capture is never in the compared text; the kit carries the journey's url", { timeout: 180_000 }, async () => {
  const s = await site();
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, "watch", "stamp.mjs"), `
export const url = ${JSON.stringify(s.url)};
export default async function (page, w, { url }) {
  // A Playwright selector, not CSS: found and marked by Retake, not by the page.
  await w.mask("text=/Updated \\\\d\\\\d:\\\\d\\\\d:\\\\d\\\\d/");
  await w.step("Open the app from the kit's address", "It opens");
  await page.goto(url);
  await w.result(url === ${JSON.stringify(s.url)}, url);
  await w.step("Stamp it", "The time appears, hidden");
  // In the same moment as the capture: no timed pass of the masks can have seen it.
  await page.evaluate(() => { const s = document.createElement("span"); s.className = "when"; s.textContent = "Updated 10:42:17"; document.body.appendChild(s); });
  await w.result(true);
}`);
    const r = await runJourney({ root, name: "stamp", file: path.join(root, "watch", "stamp.mjs"), out: path.join(root, "outputs"), ui: false });
    assert.equal(r.status, "unchanged", r.error ?? JSON.stringify(r.changes));
    const snaps = JSON.parse(fs.readFileSync(path.join(r.dir, "snapshots.json"), "utf8")) as { text: string[]; masks: unknown[] }[];
    assert.equal(snaps.length, 2);
    assert.ok(!snaps[1].text.some((t) => /10:42:17/.test(t)), `the time leaked into the text: ${JSON.stringify(snaps[1].text)}`);
    assert.ok(snaps[1].masks.length >= 1, "and its place in the picture is masked");
  } finally { s.close(); }
});

// ---------- 3. one failing step does not stop the rest being compared; 4. the failure is named ----------

test("a journey with a failing step gets a normal for its passing steps; the failing one joins it on its first pass", { timeout: 240_000 }, async () => {
  const s = await site();
  const root = workspace();
  const out = path.join(root, "outputs");
  try {
    fs.writeFileSync(path.join(root, "watch", "three.mjs"), `
export default async function (page, w) {
  await w.step("Open the app", "A greeting");
  await page.goto(${JSON.stringify(s.url)});
  await w.result(true);
  await w.step("Check it is ready", "It says Ready");
  await page.goto(${JSON.stringify(s.url)} + "/ready");
  await w.result((await page.textContent("#ok")) === "Ready", await page.textContent("#ok"));
  await w.step("Look at the button", "Stamp is there");
  await page.goto(${JSON.stringify(s.url)});
  await w.result(await page.isVisible("#stamp"));
}`);
    const go = () => runJourney({ root, name: "three", file: path.join(root, "watch", "three.mjs"), out, ui: false });
    const first = await go();
    assert.equal(first.status, "failed");
    assert.equal(first.firstRun, true);
    assert.equal(failureLine(first), "failed at step 2: Check it is ready — Not ready");
    const b = readBaseline(root, "three")!;
    assert.deepEqual(b.steps.map((x) => x.intent), ["Open the app", "Look at the button"], "the passing steps are the normal");
    assert.equal(b.waiting?.length, 1);

    // Still failing, and step 1 changed: the change is seen (before, nothing was compared).
    s.state.greeting = "Hello again";
    const second = await go();
    assert.equal(second.status, "failed", "failed still beats changed");
    const changed = second.changes.map((c) => c.intent);
    assert.ok(changed.includes("Open the app"), `the passing steps were compared: ${changed}`);
    assert.ok(!changed.includes("Check it is ready"), "the waiting step is not reported as new");
    s.state.greeting = "Welcome back";

    // The failing step passes: it joins the normal, and nothing is reported.
    s.state.step2 = true;
    const third = await go();
    assert.equal(third.status, "unchanged", JSON.stringify(third.changes));
    assert.equal(third.adopted, 1);
    const after = readBaseline(root, "three")!;
    assert.equal(after.waiting, undefined);
    assert.deepEqual(after.steps.map((x) => x.intent).sort(), ["Check it is ready", "Look at the button", "Open the app"]);
    const fourth = await go();
    assert.equal(fourth.status, "unchanged", "and from then on it is compared like the others");
  } finally { s.close(); }
});

test("a failure names its step and its note, or why the journey could not run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-fail-"));
  fs.writeFileSync(path.join(dir, "steps.json"), JSON.stringify([{ n: 1, intent: "Open", note: "", result: "pass" }, { n: 2, intent: "Open Licences", note: "No table", result: "fail" }]));
  assert.equal(failureLine({ dir, error: null }), "failed at step 2: Open Licences — No table");
  fs.writeFileSync(path.join(dir, "steps.json"), JSON.stringify([{ n: 1, intent: "The journey stopped", note: "", result: "fail" }]));
  assert.equal(failureLine({ dir, error: "timeout 30000ms" }), "failed at step 1: The journey stopped — timeout 30000ms");
  assert.equal(failureLine({ dir: "", error: "no saved login" }), "failed — no saved login");
});

// ---------- 5, 6. the list lines up, and is grouped by app ----------

test("`retake watch` lines up long names and groups journeys under their app's address", { skip: !fs.existsSync("dist/cli.js") && "needs npm run build" }, () => {
  const root = workspace();
  const j = (name: string, url: string) => fs.writeFileSync(path.join(root, "watch", `${name}.mjs`), `export const url = ${JSON.stringify(url)};\nexport default async () => {};\n`);
  j("sandbox-client-licence-request-phone", "http://127.0.0.1:8817");
  j("people", "http://127.0.0.1:8817");
  j("website", "https://www.example.com");
  const r = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "watch"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n").filter(Boolean);
  assert.deepEqual(lines.filter((l) => !l.startsWith(" ")), ["127.0.0.1:8817", "www.example.com"], r.stdout);
  const cols = lines.filter((l) => l.startsWith(" ")).map((l) => l.indexOf("Not run yet"));
  assert.equal(new Set(cols).size, 1, `the lines do not line up:\n${r.stdout}`);
});

const ask = (routes: ReturnType<typeof watchRoutes>) => async (p: string, method = "GET", payload: unknown = {}) => {
  let body = "", code = 0;
  const res = { headersSent: false, writeHead: (c: number) => { code = c; }, end: (b?: string) => { body = b ?? ""; } } as unknown as http.ServerResponse;
  await routes.handleApi({ method } as http.IncomingMessage, res, new URL(p, "http://x"), p, async () => JSON.stringify(payload));
  return { code, json: JSON.parse(body) };
};

test("the window groups journeys by app, and a run going on is a line on the list, not the page", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "watch", "a.mjs"), `export const url = "https://b.example.com";\nexport default async () => {};\n`);
  fs.writeFileSync(path.join(root, "watch", "b.mjs"), `export const url = "https://a.example.com";\nexport default async () => {};\n`);
  fs.writeFileSync(path.join(root, "watch", "c.mjs"), `export default async () => {};\n`);
  const routes = watchRoutes({ root, outRoot: () => path.join(root, "outputs"), token: "t", activity: () => {} });
  const J = (await ask(routes)("/api/watch/journeys")).json;
  assert.deepEqual(J.groups, [{ host: "a.example.com", names: ["b"] }, { host: "b.example.com", names: ["a"] }, { host: null, names: ["c"] }]);
  assert.ok("liveTitle" in J);
  const page = fs.readFileSync("src/ui/watch.html", "utf8");
  assert.ok(!/location\.replace\('\/watch\/' \+ J\.live\)/.test(page), "the list no longer jumps to the live session");
  assert.match(page, /Running now: /);
});

// ---------- 8. a run finds this workspace's window ----------

test("the window says where it listens, and only while it is alive", () => {
  const root = workspace();
  assert.equal(readWindow(root), null);
  writeWindow(root, 4377);
  assert.equal(readWindow(root), "http://localhost:4377");
  // Somebody else's window, long gone.
  fs.writeFileSync(path.join(root, ".retake", "window.json"), JSON.stringify({ url: "http://localhost:4999", port: 4999, pid: 2 ** 22 + 12345 }));
  assert.equal(readWindow(root), null);
  writeWindow(root, 4377);
  clearWindow(root);
  assert.equal(readWindow(root), null);
});

// ---------- the "Add an app" flow ----------

test("adding the same app twice does not make two of anything", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "watch", "sign-in.mjs"), `export const title = "Sign in";\nexport const url = "https://app.example.com";\nexport default async () => {};\n`);
  assert.equal(alreadyWatched(root, "https://app.example.com", { title: "sign in" }), "sign-in");
  assert.equal(alreadyWatched(root, "https://other.example.com", { title: "Sign in" }), null, "the same title on another app is another journey");
  let ran = 0;
  const s: Suggestion = { origin: "https://app.example.com", at: "", by: "the pages", signIn: null, signedIn: false, proposals: [{ title: "Sign in", checks: "x", changes: "reads", steps: [{ do: "signIn" }] }] };
  const res = await addJourneys({ root, out: path.join(root, "outputs"), suggestion: s, pick: [1], run: async () => { ran++; return {} as RunRecord; } });
  assert.deepEqual(res, [{ title: "Sign in", added: false, already: true, name: "sign-in", why: "Already watched, as watch/sign-in.mjs." }]);
  assert.equal(ran, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, "watch")).filter((f) => f.endsWith(".mjs")), ["sign-in.mjs"]);
});

test("after Not now on the sign-in, journeys that need it start unticked", { timeout: 120_000 }, async () => {
  const app = await startFernway();
  const root = workspace();
  const was = { login: process.env.RETAKE_LOGIN_FILE, model: process.env.RETAKE_MODEL };
  process.env.RETAKE_LOGIN_FILE = path.join(root, "logins.json");
  process.env.RETAKE_MODEL = "none";   // the pages alone: quick, and the same everywhere
  try {
    const routes = watchRoutes({ root, outRoot: () => path.join(root, "outputs"), token: "t", activity: () => {} });
    const go = ask(routes);
    let J = (await go("/api/watch/suggest", "POST", { url: app.url })).json;
    const until = async (phase: string) => { for (let i = 0; i < 240 && J.phase !== phase; i++) { await new Promise((ok) => setTimeout(ok, 250)); J = (await go(`/api/watch/suggest/${J.id}`)).json; } assert.equal(J.phase, phase, J.error ?? ""); };
    await until("signin");
    J = (await go(`/api/watch/suggest/${J.id}/continue`, "POST", { skip: true })).json;
    await until("ready");
    const signIn = J.proposals.find((p: { title: string }) => p.title === "Sign in");
    assert.ok(signIn, JSON.stringify(J.proposals));
    assert.equal(signIn.noAccount, true);
    assert.equal(signIn.ticked, false, "it cannot pass without the test account");
    const pricing = J.proposals.find((p: { title: string }) => /pricing/i.test(p.title));
    assert.equal(pricing.ticked, true, "a public page is still ticked");
  } finally {
    await app.close();
    for (const [k, v] of [["RETAKE_LOGIN_FILE", was.login], ["RETAKE_MODEL", was.model]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ---------- what the tour found ----------

import { runBatch } from "../src/watch/auto.js";
import { writeLastRun } from "../src/watch/deploys.js";
import { momentOf, CLIP_MIN_MS, SESSION_START_MS } from "../src/watch/journey-store.js";
import { withScheme, isLocalHost, markSpace } from "../src/watch/spaces.js";
import { explore, plainProposals } from "../src/watch/suggest.js";

test("a bare local address is http, anything else https", () => {
  assert.equal(withScheme("127.0.0.1:4563"), "http://127.0.0.1:4563");
  assert.equal(withScheme("localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(withScheme("192.168.1.20:8080"), "http://192.168.1.20:8080");
  assert.equal(withScheme("10.0.0.5"), "http://10.0.0.5");
  assert.equal(withScheme("172.20.1.1:5000"), "http://172.20.1.1:5000");
  assert.equal(withScheme("myapp.local:3000"), "http://myapp.local:3000");
  assert.equal(withScheme("app.example.com"), "https://app.example.com");
  assert.equal(withScheme("172.32.0.1"), "https://172.32.0.1", "not a private range");
  assert.equal(withScheme("http://staging.example.com"), "http://staging.example.com", "a scheme given is kept");
  assert.equal(isLocalHost("8.8.8.8"), false);
});

test("the header says how the last run stands now: a change accepted since is not still \"changed\"", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "watch", "pricing.mjs"), `export default async () => {};\n`);
  writeLastRun(root, { at: new Date().toISOString(), trigger: "nightly", journeys: 1, changed: 1, failed: 0, skipped: 0 });
  const routes = watchRoutes({ root, outRoot: () => path.join(root, "outputs"), token: "t", activity: () => {} });
  const J = (await ask(routes)("/api/watch/journeys")).json;
  assert.equal(J.summary, null);
  assert.match(J.ran, /as it does every night — 1 journey, nothing unexpected\.$/);
});

test("a step over in a moment gets its two pictures, not a second of blank video", () => {
  const snap = (n: number, t: number, tEnd: number) => ({ n, scenario: null, intent: `Step ${n}`, result: "pass" as const, url: "", text: [], shot: `snapshots/step-0${n}.png`, masks: [], width: 0, height: 0, t, tEnd });
  const rec = (n: number) => ({ journey: "j", title: "j", at: "", session: "s", dir: "", status: "changed" as const, scheduled: false, error: null, steps: 1, changes: [{ n, scenario: null, intent: `Step ${n}`, kinds: ["text" as const], before: "a", after: "b", t: null, tEnd: null }] });
  assert.equal(momentOf(rec(1), null, [snap(1, 9, 1136)], [{ n: 1, note: "", t: 9, tEnd: 1136 }])!.clip, null, "a one-step journey's 1.1 s");
  const long = momentOf(rec(2), null, [snap(2, 4000, 4000 + CLIP_MIN_MS + 500)], [{ n: 2, note: "", t: 4000, tEnd: 4000 + CLIP_MIN_MS + 500 }])!;
  assert.deepEqual(long.clip, { start: 3.7, end: 8 }, "a step worth watching keeps its clip");
  const shortMid = momentOf(rec(2), null, [snap(2, 4000, 4800)], [{ n: 2, note: "", t: 4000, tEnd: 4800 }])!;
  assert.ok(shortMid.clip, "a short step in the middle has real video around it");
  assert.ok(SESSION_START_MS <= 1000);
});

test("reads run before writes, and what a data journey makes never reads as a change, in it or in any other journey", { timeout: 900_000 }, async () => {
  // The order, with nothing run.
  {
    const root = workspace();
    const w = (n: string, data: boolean) => fs.writeFileSync(path.join(root, "watch", `${n}.mjs`), `export const url = "http://127.0.0.1:1";\n${data ? "export const changesData = true;\n" : ""}export default async () => {};\n`);
    w("a-create", true); w("b-sign-in", false); w("c-invite", true); w("d-pricing", false);
    markSpace(root, "http://127.0.0.1:1", true);
    const order: string[] = [];
    await runBatch({ root, out: path.join(root, "outputs"), trigger: "hand", journeys: ["a-create", "b-sign-in", "c-invite", "d-pricing"].map((n) => ({ name: n, file: path.join(root, "watch", `${n}.mjs`) })),
      runner: async (j) => { order.push(j.name); return { journey: j.name, title: j.name, at: "", session: "", dir: "", status: "unchanged", scheduled: false, error: null, steps: 1, changes: [] }; } });
    assert.deepEqual(order, ["b-sign-in", "d-pricing", "a-create", "c-invite"]);
  }
  // For real: the tour's case. A project made every run; a one-line price deploy is the only change.
  const app = await startFernway();
  const root = workspace();
  const out = path.join(root, "outputs");
  const was = { login: process.env.RETAKE_LOGIN_FILE };
  process.env.RETAKE_LOGIN_FILE = path.join(root, "logins.json");
  try {
    const { saveLogin } = await import("../src/logins.js");
    saveLogin(new URL(app.url).host, ACCOUNT);
    markSpace(root, app.url, true);
    const ps = plainProposals(await explore(app.url));
    const pick = ["Sign in", "Check the pricing page", "Create a project"].map((t) => ps.findIndex((p) => p.title === t) + 1);
    assert.ok(pick.every((n) => n > 0), ps.map((p) => p.title).join(", "));
    const s: Suggestion = { origin: new URL(app.url).origin, at: "", by: "the pages", signIn: { url: `${app.url}/login` }, signedIn: true, proposals: ps };
    const added = await addJourneys({ root, out, suggestion: s, pick });
    assert.ok(added.every((a) => a.added), JSON.stringify(added));
    const all = () => fs.readdirSync(path.join(root, "watch")).filter((f) => f.endsWith(".mjs")).map((f) => ({ name: f.replace(/\.mjs$/, ""), file: path.join(root, "watch", f) }));
    const batch = () => runBatch({ root, out, trigger: "hand", journeys: all() });
    const quiet = await batch();
    assert.deepEqual(quiet.runs.map((r) => [r.journey, r.status]).sort(), [["check-the-pricing-page", "unchanged"], ["create-a-project", "unchanged"], ["sign-in", "unchanged"]],
      JSON.stringify(quiet.runs.map((r) => r.changes)));
    assert.ok(app.state.projects.filter((p: string) => p === "Watch check").length >= 2, "projects really were made");
    app.deploy({ plan: "Studio" });
    const after = await batch();
    assert.deepEqual(after.runs.filter((r) => r.status !== "unchanged").map((r) => r.journey), ["check-the-pricing-page"], "only the price changed");
  } finally {
    await app.close();
    if (was.login === undefined) delete process.env.RETAKE_LOGIN_FILE; else process.env.RETAKE_LOGIN_FILE = was.login;
  }
});
