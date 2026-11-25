/** Journeys and the nightly run: what counts as a change, what a person
    sees about it in one line, accepting a change as the new normal, and the
    words typed to schedule it. The last tests run real journeys in a real
    browser against a page that changes under them. */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  CHANGED_BLOCKS, compareSnapshots, decodePng, describeChange, encodePng, matchSteps, pictureDiff, textDiff, verdict,
  type Picture, type Snapshot,
} from "../src/watch/compare.js";
import {
  acceptLast, acceptRun, journeyLine, journeyStates, listJourneys, momentOf, nightlyNotice, parseWatchSchedule, pickJourneys,
  readBaseline, readLast, summaryLine, whenWord, writeRun, type RunRecord,
} from "../src/watch/journey-store.js";
import { runJourney } from "../src/watch/journeys.js";
import { watchRoutes } from "../src/ui/watch-routes.js";

const blank = (w: number, h: number, v = 255): Picture => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v) });
const paint = (p: Picture, x0: number, y0: number, w: number, h: number, v = 0) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const o = (y * p.width + x) * 4; p.data[o] = p.data[o + 1] = p.data[o + 2] = v; }
  return p;
};
const snap = (n: number, intent: string, over: Partial<Snapshot> = {}): Snapshot => ({
  n, scenario: null, intent, result: "pass", url: "http://app/", text: [], shot: null, masks: [], width: 0, height: 0, t: n * 1000, tEnd: n * 1000 + 800, ...over,
});

// ---------- pictures ----------

test("a PNG made here reads back pixel for pixel", () => {
  const p = paint(blank(37, 21), 3, 4, 10, 5, 90);
  const q = decodePng(encodePng(p));
  assert.equal(q.width, 37);
  assert.equal(q.height, 21);
  assert.deepEqual(Buffer.from(q.data), Buffer.from(p.data));
  assert.throws(() => decodePng(Buffer.from("not a png")));
});

test("the picture: the same is unchanged, scattered noise is unchanged, a small patch is a change", () => {
  const a = blank(200, 120);
  assert.equal(pictureDiff(a, blank(200, 120)).changed, false);
  // Font smoothing: single pixels here and there, and faint tints everywhere.
  const noisy = blank(200, 120, 240);
  for (let i = 0; i < 300; i++) paint(noisy, (i * 37) % 200, (i * 53) % 120, 1, 1, 0);
  assert.equal(pictureDiff(a, noisy).changed, false, "noise is not a change");
  // An icon gone: a 24 × 24 patch.
  const icon = paint(blank(200, 120), 40, 30, 24, 24);
  const d = pictureDiff(a, icon);
  assert.equal(d.changed, true);
  assert.ok(d.changedBlocks >= CHANGED_BLOCKS);
  assert.ok(d.box && d.box.x <= 40 / 200 && d.box.x + d.box.width >= 64 / 200, "the box covers the patch");
  // Smaller than the threshold: one glyph-sized speck.
  assert.equal(pictureDiff(a, paint(blank(200, 120), 10, 10, 8, 8)).changed, false);
  // A different size is always a change.
  assert.equal(pictureDiff(a, blank(201, 120)).changed, true);
});

test("a masked region counts for nothing in the picture", () => {
  const a = paint(blank(200, 120), 100, 60, 60, 30, 20);
  const b = paint(blank(200, 120), 100, 60, 60, 30, 200);
  assert.equal(pictureDiff(a, b).changed, true);
  assert.equal(pictureDiff(a, b, [{ x: 96, y: 56, width: 70, height: 40 }]).changed, false);
  // …but only that region: a change beside it still counts.
  paint(b, 10, 10, 30, 30);
  assert.equal(pictureDiff(a, b, [{ x: 96, y: 56, width: 70, height: 40 }]).changed, true);
});

// ---------- text ----------

test("text: lines gone and lines new, whitespace aside, order aside, repeats counted", () => {
  assert.deepEqual(textDiff(["Licences", "Ends  25 Nov"], ["Ends 25 Nov", "Licences"]), { added: [], removed: [] });
  assert.deepEqual(textDiff(["Licences", "Ends 25 Nov"], ["Licences", "Ends 26 Nov"]), { added: ["Ends 26 Nov"], removed: ["Ends 25 Nov"] });
  assert.deepEqual(textDiff(["Row"], ["Row", "Row"]), { added: ["Row"], removed: [] });
});

// ---------- steps ----------

test("steps are matched by what they do, so a step added in the middle changes only itself", () => {
  const before = [snap(1, "Open"), snap(2, "Read"), snap(3, "Leave")];
  const after = [snap(1, "Open"), snap(2, "Look around"), snap(3, "Read"), snap(4, "Leave")];
  const changes = compareSnapshots(before, after, () => null);
  assert.deepEqual(changes.map((c) => [c.intent, c.kinds]), [["Look around", ["new"]]]);
  const { pairs } = matchSteps([snap(1, "A"), snap(2, "A")], [snap(1, "A")]);
  assert.equal(pairs.length, 2, "the second A is missing, not matched twice");
  assert.deepEqual(compareSnapshots([snap(1, "A"), snap(2, "B")], [snap(1, "A")], () => null).map((c) => c.kinds), [["missing"]]);
});

test("a step changes when its verdict, its text or its picture does", () => {
  const pic = new Map<string, Picture>([["a.png", blank(80, 80)], ["b.png", paint(blank(80, 80), 10, 10, 30, 30)]]);
  const load = (s: Snapshot) => (s.shot ? pic.get(s.shot) ?? null : null);
  const c = compareSnapshots(
    [snap(1, "Open", { text: ["Hello"], shot: "a.png" }), snap(2, "Go", { shot: "a.png" }), snap(3, "Stay", { text: ["Same"], shot: "a.png" })],
    [snap(1, "Open", { text: ["Hello there"], shot: "a.png" }), snap(2, "Go", { result: "fail", shot: "b.png" }), snap(3, "Stay", { text: ["Same"], shot: "a.png" })],
    load,
  );
  assert.deepEqual(c.map((x) => [x.n, x.kinds]), [[1, ["text"]], [2, ["result", "picture"]]]);
  assert.deepEqual(c[0].text, { added: ["Hello there"], removed: ["Hello"] });
  assert.equal(describeChange(c[0]), "The text changed");
  assert.equal(describeChange(c[1]), "It failed, and passed before, the picture changed");
});

test("failed beats changed; a run with no steps failed", () => {
  const changed = compareSnapshots([snap(1, "A", { text: ["x"] })], [snap(1, "A", { text: ["y"] })], () => null);
  assert.equal(verdict({ error: null, steps: [snap(1, "A")], changes: [] }), "unchanged");
  assert.equal(verdict({ error: null, steps: [snap(1, "A")], changes: changed }), "changed");
  assert.equal(verdict({ error: null, steps: [snap(1, "A", { result: "fail" })], changes: changed }), "failed");
  assert.equal(verdict({ error: "timed out", steps: [snap(1, "A")], changes: [] }), "failed");
  assert.equal(verdict({ error: null, steps: [], changes: [] }), "failed");
});

// ---------- words ----------

const run = (over: Partial<RunRecord>): RunRecord => ({ journey: "j", title: "J", at: new Date(2026, 11, 4, 3, 0).toISOString(), session: "j-1", dir: "/nowhere", status: "unchanged", scheduled: true, error: null, steps: 3, changes: [], ...over });

test("when: the small hours and the evening before are last night", () => {
  const morning = new Date(2026, 11, 4, 9, 0);
  assert.equal(whenWord(new Date(2026, 11, 4, 3, 0).toISOString(), morning), "last night");
  assert.equal(whenWord(new Date(2026, 11, 3, 23, 0).toISOString(), morning), "last night");
  assert.equal(whenWord(new Date(2026, 11, 4, 8, 0).toISOString(), morning), "today");
  assert.equal(whenWord(new Date(2026, 11, 3, 12, 0).toISOString(), morning), "yesterday");
  assert.equal(whenWord(new Date(2026, 11, 1, 3, 0).toISOString(), morning), "on 1 Dec");
});

test("each journey says where it stands in one line", () => {
  const now = new Date(2026, 11, 4, 9, 0);
  const b = { acceptedAt: new Date(2026, 11, 3, 3, 0).toISOString(), from: "x", steps: [] };
  assert.equal(journeyLine(null, null, now), "Not run yet");
  assert.equal(journeyLine(run({}), b, now), "Unchanged since 3 Dec");
  assert.equal(journeyLine(run({ status: "changed" }), b, now), "Changed last night");
  assert.equal(journeyLine(run({ status: "failed" }), b, now), "Failed last night");
  assert.equal(summaryLine([run({}), run({ status: "changed" })], now), "1 journey changed since last night");
  assert.equal(summaryLine([run({ status: "changed" }), run({ status: "changed" }), run({ status: "failed" })], now), "2 journeys changed and 1 failed since last night");
  assert.equal(summaryLine([run({}), null], now), null);
});

test("the nightly run is silent unless something changed or failed, and then says it once", () => {
  const now = new Date(2026, 11, 4, 3, 5);
  assert.equal(nightlyNotice([run({}), run({})], now), null);
  const n = nightlyNotice([run({}), run({ status: "changed", title: "Portal – licences" })], now);
  assert.deepEqual(n, { title: "Retake Watch", body: "1 journey changed since last night: Portal – licences" });
});

test("the moment a changed journey opens to: the first change, with its clip", () => {
  const changes = compareSnapshots([snap(1, "A"), snap(2, "B", { text: ["old"] })], [snap(1, "A"), snap(2, "B", { text: ["new"], shot: "snapshots/step-02.png" })], () => null);
  const m = momentOf(run({ status: "changed", changes }), null, [], [{ n: 2, note: "Shown", t: 2000, tEnd: 2800 }]);
  assert.equal(m?.n, 2);
  assert.equal(m?.what, "The text changed");
  assert.deepEqual(m?.clip, { start: 1.7, end: 4.3 });
  const f = momentOf(run({ status: "failed", error: "boom" }), null, [snap(1, "A"), snap(2, "B", { result: "fail" })], []);
  assert.equal(f?.n, 2);
  assert.equal(f?.note, "boom");
});

// ---------- the workspace ----------

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "journeys-"));
  fs.mkdirSync(path.join(root, "watch"));
  return root;
}

test("journeys are the scripts in watch/; helpers starting with _ are not", () => {
  const root = workspace();
  for (const f of ["portal.mjs", "site-home.js", "_lib.mjs", ".hidden.mjs", "notes.md", "Bad Name.mjs"]) fs.writeFileSync(path.join(root, "watch", f), "");
  assert.deepEqual(listJourneys(root).map((j) => j.name), ["portal", "site-home"]);
  assert.deepEqual(pickJourneys(listJourneys(root), "all").map((j) => j.name), ["portal", "site-home"]);
  assert.deepEqual(pickJourneys(listJourneys(root), "watch/portal.mjs").map((j) => j.name), ["portal"]);
  assert.throws(() => pickJourneys(listJourneys(root), "nope"), /there are: portal, site-home/);
  assert.throws(() => pickJourneys([], "all"), /watch\/<name>\.mjs/);
});

test("accepting makes a run the normal, whole; a failed run cannot be", () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "watch", "j.mjs"), "");
  const sess = path.join(root, "outputs", "watch", "j-1");
  fs.mkdirSync(path.join(sess, "snapshots"), { recursive: true });
  fs.writeFileSync(path.join(sess, "snapshots", "step-01.png"), encodePng(blank(4, 4)));
  fs.writeFileSync(path.join(sess, "snapshots.json"), JSON.stringify([snap(1, "A", { shot: "snapshots/step-01.png", text: ["v2"] })]));
  writeRun(root, run({ status: "failed", dir: sess }));
  assert.throws(() => acceptLast(root, "j"), /cannot be the normal/);
  writeRun(root, run({ status: "changed", dir: sess }));
  const r = acceptLast(root, "j");
  assert.equal(r.status, "unchanged");
  assert.equal(readLast(root, "j")?.status, "unchanged");
  const b = readBaseline(root, "j")!;
  assert.equal(b.from, "j-1");
  assert.deepEqual(b.steps[0].text, ["v2"]);
  assert.ok(fs.existsSync(path.join(root, "watch", ".journeys", "j", "baseline", "snapshots", "step-01.png")));
  assert.equal(journeyStates(root)[0].line.startsWith("Unchanged since"), true);
  // Accepting again replaces, never mixes.
  fs.writeFileSync(path.join(sess, "snapshots.json"), JSON.stringify([snap(1, "B")]));
  acceptRun(root, "j", sess, "j-1");
  assert.deepEqual(readBaseline(root, "j")!.steps.map((s) => s.intent), ["B"]);
});

// ---------- the words typed ----------

test("schedule: daily, weekdays or off, at a 24-hour time, 03:00 unless said", () => {
  assert.deepEqual(parseWatchSchedule("daily", undefined), { every: "daily", at: "03:00" });
  assert.deepEqual(parseWatchSchedule("Weekdays", "6:30"), { every: "weekdays", at: "6:30" });
  assert.deepEqual(parseWatchSchedule("off", undefined), { every: "off", at: "03:00" });
  assert.deepEqual(parseWatchSchedule(undefined, undefined), { every: null, at: "03:00" });
  assert.throws(() => parseWatchSchedule("hourly", undefined), /daily, weekdays or off/);
  assert.throws(() => parseWatchSchedule("daily", "3am"), /HH:MM/);
});

test("the CLI: a wrong word or a journey that is not there stops with a sentence, and nothing is scheduled", () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "watch", "home.mjs"), "export default async () => {};");
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const cli = (...a: string[]) => spawnSync(process.execPath, [tsx, path.resolve("src/cli.ts"), ...a], { cwd: root, encoding: "utf8", env: { ...process.env, RETAKE_ROOT: root } });
  const bad = cli("watch", "schedule", "hourly");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /say daily, weekdays or off/);
  const late = cli("watch", "schedule", "daily", "--at", "25:00");
  assert.equal(late.status, 1);
  assert.match(late.stderr, /HH:MM/);
  const none = cli("watch", "run", "portal");
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no journey called "portal" — there are: home/);
  assert.ok(!fs.existsSync(path.join(root, ".retake", "watch-schedule.json")));
  const list = cli("watch");
  assert.equal(list.status, 0);
  assert.match(list.stdout, /home\s+Not run yet/);
});

// ---------- real runs ----------

/** A page that changes when the test says so, and a sign-in on three screens. */
function site() {
  const state = { greeting: "Welcome back", stamp: "Signed in 09:00", fail: false, icon: true };
  const page = (body: string) => `<!doctype html><html><body style="font:16px system-ui;margin:40px">${body}</body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "content-type": "text/html" });
    if (u.pathname === "/") return res.end(page(`<h1>${state.greeting}</h1><p class="stamp">${state.stamp}</p>${state.icon ? '<div style="width:48px;height:48px;background:#c33;border-radius:8px"></div>' : ""}<a id="go" href="/licences">Licences</a>`));
    if (u.pathname === "/licences") return res.end(page(state.fail ? "<h1>Something went wrong</h1>" : "<h1>Licences</h1><table><tr><td>Survey Suite</td></tr></table>"));
    if (u.pathname === "/login") return res.end(page(`<form method="post" action="/password"><label>E-mail <input id="loginName" name="loginName" autocomplete="username"></label><button>Next</button></form>`));
    if (u.pathname === "/password") return res.end(page(`<form method="post" action="/code"><input type="password" name="pw"><button>Next</button></form>`));
    if (u.pathname === "/code") return res.end(page(`<form method="post" action="/"><input name="code" autocomplete="one-time-code"><button>Next</button></form>`));
    res.end(page("?"));
  });
  return new Promise<{ url: string; state: typeof state; close: () => void }>((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, state, close: () => server.close() })));
}

const JOURNEY = (url: string) => `
export const title = "Sample";
export default async function (page, w) {
  await w.mask(".stamp");                      // changes every night on its own
  await w.step("Open the home page", "It greets the person");
  await page.goto(${JSON.stringify(url)});
  await w.result(await page.isVisible("h1"), "Greeted");
  await w.beat();
  await w.step("Open Licences", "The licence is listed");
  await page.click("#go");
  await page.waitForSelector("h1");
  await w.result(await page.isVisible("table"), await page.textContent("h1"));
}
`;

test("a journey run for real: first run is the normal; text, picture and failure are caught; a mask is not; accepting holds", { timeout: 240_000 }, async () => {
  const s = await site();
  const root = workspace();
  const out = path.join(root, "outputs");
  fs.writeFileSync(path.join(root, "watch", "sample.mjs"), JOURNEY(s.url));
  const go = () => runJourney({ root, name: "sample", file: path.join(root, "watch", "sample.mjs"), out, ui: false, scheduled: true });
  try {
    const first = await go();
    assert.equal(first.status, "unchanged");
    assert.equal(first.firstRun, true);
    assert.equal(readBaseline(root, "sample")?.steps.length, 2);
    const shot = readBaseline(root, "sample")!.steps[0];
    assert.ok(shot.text.includes("Welcome back"));
    assert.ok(!shot.text.some((l) => l.includes("Signed in")), "masked text is left out");
    assert.ok(decodePng(fs.readFileSync(path.join(root, "watch", ".journeys", "sample", "baseline", shot.shot!))).width === 1280);

    s.state.stamp = "Signed in 03:00";                   // only the masked part moved
    const quiet = await go();
    assert.equal(quiet.status, "unchanged", JSON.stringify(quiet.changes));

    s.state.greeting = "Welcome";                        // the text
    const text = await go();
    assert.equal(text.status, "changed");
    assert.equal(text.changes[0].n, 1);
    assert.ok(text.changes[0].kinds.includes("text"));
    assert.deepEqual(text.changes[0].text, { added: ["Welcome"], removed: ["Welcome back"] });

    // The window: the journey says so, opens to the moment, and accepts with one press.
    const routes = watchRoutes({ root, outRoot: () => out, token: "t", activity: () => {} });
    const ask = async (p: string, method = "GET") => {
      let body = "", code = 0;
      const res = { headersSent: false, writeHead: (c: number) => { code = c; }, end: (b?: string) => { body = b ?? ""; } } as unknown as http.ServerResponse;
      await routes.handleApi({ method } as http.IncomingMessage, res, new URL(p, "http://x"), p, async () => "{}");
      return { code, json: JSON.parse(body) };
    };
    const list = await ask("/api/watch/journeys");
    assert.match(list.json.summary, /^1 journey changed (today|since last night)$/);
    assert.match(list.json.journeys[0].line, /^Changed (today|last night)$/);
    const one = await ask("/api/watch/journeys/sample");
    assert.equal(one.json.moment.n, 1);
    assert.match(one.json.moment.what, /^The text changed/);
    assert.ok(one.json.moment.before && one.json.moment.after && one.json.video);
    const acc = await ask("/api/watch/journeys/sample/accept", "POST");
    assert.deepEqual(acc.json, { ok: true, next: null });
    assert.match((await ask("/api/watch/journeys")).json.journeys[0].line, /^Unchanged since/);

    const held = await go();
    assert.equal(held.status, "unchanged", "the accepted change is the normal now");

    s.state.icon = false;                                // the picture only
    const pic = await go();
    assert.equal(pic.status, "changed");
    assert.deepEqual(pic.changes.map((c) => c.kinds), [["picture"]]);
    assert.ok(pic.changes[0].picture?.box);
    s.state.icon = true;

    s.state.fail = true;                                 // a step that fails
    const failed = await go();
    assert.equal(failed.status, "failed");
    assert.equal(journeyStates(root)[0].line.startsWith("Failed"), true);
    assert.ok(failed.changes.some((c) => c.kinds.includes("result")));

    // Quiet nights are tidied: only the newest unchanged one is kept.
    const kept = fs.readdirSync(path.join(out, "watch")).filter((d) => d.startsWith("sample-"));
    assert.ok(!kept.includes(first.session), "an older quiet night went");
    assert.ok(kept.includes(text.session) && kept.includes(failed.session), "changed and failed nights stay");
  } finally { s.close(); }
});

test("signIn uses the saved login on every screen, masks what it types, and says plainly when there is none", { timeout: 120_000 }, async () => {
  const s = await site();
  const root = workspace();
  const out = path.join(root, "outputs");
  const was = process.env.RETAKE_LOGIN_FILE;
  process.env.RETAKE_LOGIN_FILE = path.join(root, "logins.json");
  const { saveLogin } = await import("../src/logins.js");
  fs.writeFileSync(path.join(root, "watch", "in.mjs"), `
export default async function (page, w, { signIn }) {
  await w.step("Sign in", "The home page opens");
  await page.goto(${JSON.stringify(s.url + "/login")});
  await signIn(${JSON.stringify(s.url)});
  await w.result(await page.isVisible("h1"), "Signed in");
}`);
  const go = () => runJourney({ root, name: "in", file: path.join(root, "watch", "in.mjs"), out, ui: false });
  try {
    const none = await go();
    assert.equal(none.status, "failed");
    assert.match(none.error ?? "", /no saved login for 127\.0\.0\.1:\d+ — run `retake login http:\/\/127\.0\.0\.1:\d+`/);
    saveLogin(new URL(s.url).host, { user: "test@example.com", password: "pa55-word-xyz", totp: "JBSWY3DPEHPK3PXP" });
    const ok = await go();
    assert.equal(ok.status, "unchanged", ok.error ?? "");
    const files = fs.readdirSync(ok.dir).map((f) => path.join(ok.dir, f)).filter((f) => f.endsWith(".json") || f.endsWith(".md"));
    for (const f of files) assert.ok(!fs.readFileSync(f, "utf8").includes("pa55-word-xyz"), `${path.basename(f)} holds the password`);
  } finally {
    s.close();
    if (was === undefined) delete process.env.RETAKE_LOGIN_FILE; else process.env.RETAKE_LOGIN_FILE = was;
  }
});
