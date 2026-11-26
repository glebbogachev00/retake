/** Watch for any team, with nothing to set up: Retake notices a new version
    of an app by itself (a fingerprint of what is deployed, seen twice before
    anything runs), and suggests the journeys worth watching from nothing but
    the app's address. Journeys that change data run only where the person
    said the app is a test space. The last tests do all of it for real,
    against a small made-up app that can be "deployed" again. */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  advance, cleanAssetUrl, deployNotice, fingerprintOf, isHashedAsset, lastRunOf, nightlyOnlyLine, observe, outcomeWords, ranLine,
  readDeploys, scheduleStatusLine, versionFields, writeDeploys, CHECK_EVERY_MIN, type Fingerprint,
} from "../src/watch/deploys.js";
import { cronLine, describeSchedule, labelFor, plistXml } from "../src/schedule.js";
import { gate, journeyMeta, markSpace, spaceAnswer, spaceQuestion } from "../src/watch/spaces.js";
import { addJourneys, changesData, journeySource, parsePick, parseProposals, plainProposals, nameFor, type Exploration, type Suggestion } from "../src/watch/suggest.js";
import { checkForDeploys, runBatch } from "../src/watch/auto.js";
import type { RunRecord } from "../src/watch/journey-store.js";
import { parseWatchSchedule } from "../src/watch/journey-store.js";
import { watchRoutes } from "../src/ui/watch-routes.js";
// @ts-expect-error — a plain .mjs fixture
import { startFernway, ACCOUNT } from "./fixtures/fernway/serve.mjs";

const workspace = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "retake-auto-")); fs.mkdirSync(path.join(d, "watch")); return d; };

// ---------- the fingerprint ----------

const page = (o: { hash?: string; nonce?: string; extra?: string } = {}) => `<!doctype html><html><head>
<meta name="csrf-token" content="${o.nonce ?? "a1b2c3"}">
<link rel="stylesheet" href="/assets/index-${o.hash ?? "B7f3a9Lk"}.css">
<link rel="stylesheet" href="/fonts.css?t=${o.nonce === "x" ? 1764000000 : 1764000999}&family=Inter">
<link rel="icon" href="/favicon.ico">
<script nonce="${o.nonce ?? "n0nce"}">window.__t = ${Date.now()}</script>
<script type="module" src="/assets/index-${o.hash ?? "B7f3a9Lk"}.js?nonce=${o.nonce ?? "zz"}"></script>
<!-- <script src="/assets/old-123456.js"></script> -->
${o.extra ?? ""}</head><body><h1>Hi</h1></body></html>`;
const fp = (html: string, headers: Record<string, string> = {}, probes?: Record<string, unknown>) => fingerprintOf({ html, headers, base: "https://app.example.com/", probes });

test("hashed file names are a version; nonces, tokens and timestamps are not", () => {
  const a = fp(page({ nonce: "x" }));
  assert.equal(a.basis, "assets");
  assert.ok(a.id);
  assert.deepEqual(a.assets, ["/assets/index-B7f3a9Lk.css", "/assets/index-B7f3a9Lk.js", "/fonts.css?family=Inter"]);
  // The same build, another request: a new nonce, a new CSRF token, a new timestamp.
  assert.equal(fp(page({ nonce: "y" })).id, a.id, "per-request noise moved the fingerprint");
  // A new build: new file names.
  assert.notEqual(fp(page({ hash: "C9d2e4Qx" })).id, a.id);
  // Comments are not the page.
  assert.ok(!a.assets.some((x) => x.includes("old-")));
});

test("what counts as a hashed file", () => {
  for (const u of ["/assets/index-B7f3a9Lk.js", "/static/js/main.3f2a1b9c.js", "/_next/static/chunks/app-8d9c2e1f.js", "/_next/static/Xk2mP9qL7vB/_buildManifest.js", "/app.css?v=2.4.1", "/assets/v2.14.1/app.js", "/bundle_4f1e2d3c.min.js"]) assert.ok(isHashedAsset(u), u);
  for (const u of ["/app.js", "/assets/main.css", "/js/vendor.bundle.js", "/static/site.css", "/fonts.css?family=Inter"]) assert.ok(!isHashedAsset(u), u);
  assert.equal(cleanAssetUrl("/a.js?ts=1764000000123&v=3&utm_source=x", "https://app.example.com/"), "/a.js?v=3");
  assert.equal(cleanAssetUrl("https://cdn.example.net/a-1a2b3c4d.js", "https://app.example.com/"), "https://cdn.example.net/a-1a2b3c4d.js");
  assert.equal(cleanAssetUrl("data:text/javascript,1", "https://app.example.com/"), null);
});

test("without hashed files, a version the app states is the fingerprint; without either, there is none", () => {
  const plain = `<html><head><link rel="stylesheet" href="/app.css"><script src="/app.js"></script></head><body></body></html>`;
  const none = fp(plain);
  assert.equal(none.basis, "none");
  assert.equal(none.id, null, "an app that shows no version is not watched by a cheap look");
  const meta = fp(plain.replace("<head>", `<head><meta name="version" content="1.4.2">`));
  assert.equal(meta.basis, "marker");
  assert.notEqual(fp(plain.replace("<head>", `<head><meta name="version" content="1.4.3">`)).id, meta.id);
  assert.equal(fp(plain, { "X-Build": "8f2c1d" }).basis, "marker");
  assert.equal(fp(plain.replace("<body>", `<body data-build="2026.11.25-3">`)).markers["body:data-build"], "2026.11.25-3");
  assert.equal(fp(`${plain}<script id="__NEXT_DATA__" type="application/json">{"buildId":"Xk2mP9qL7vB"}</script>`).markers["next:buildId"], "Xk2mP9qL7vB");
  // /version and /healthz: a version field, never a clock or a counter.
  assert.deepEqual(versionFields({ status: "ok", version: "3.1.0", uptime: 1234, time: "2026-11-25T10:00:00Z", app: { commit: "abc1234" } }), { version: "3.1.0", "app.commit": "abc1234" });
  const probed = fp(plain, {}, { "/healthz": { status: "ok", uptime: 99, build: "551" } });
  assert.equal(probed.basis, "marker");
  assert.equal(fp(plain, {}, { "/healthz": { status: "ok", uptime: 100, build: "551" } }).id, probed.id, "uptime is not a version");
  // The ETag only when there is nothing better.
  assert.equal(fp(plain, { etag: 'W/"5a-xyz"' }).basis, "etag");
  assert.equal(fp(page(), { etag: '"anything"' }).basis, "assets");
});

// ---------- seen twice in a row ----------

test("a new version runs exactly once, after it is seen twice in a row; a blip or a rolling deploy runs nothing", () => {
  const F = (id: string | null, basis: Fingerprint["basis"] = "assets"): Fingerprint => ({ id, basis, assets: [], markers: {} });
  const o = "https://app.example.com";
  let s = advance(undefined, o, F("a"));
  assert.equal(s.changed, false, "the first look is what is there now");
  assert.equal(s.next.current, "a");
  s = advance(s.next, o, F("a"));
  assert.equal(s.changed, false, "unchanged means nothing happens");
  s = advance(s.next, o, F("b"));
  assert.equal(s.changed, false, "seen once: not yet");
  assert.equal(s.next.candidate?.seen, 1);
  s = advance(s.next, o, F("b"));
  assert.equal(s.changed, true, "seen twice in a row: run");
  assert.equal(s.next.current, "b");
  s = advance(s.next, o, F("b"));
  assert.equal(s.changed, false, "and only once");
  // Rolling out: old and new answer in turn. Nothing settles, nothing runs.
  let r = s.next, runs = 0;
  for (const id of ["c", "b", "c", "b", "c"]) { const x = advance(r, o, F(id)); r = x.next; runs += Number(x.changed); }
  assert.equal(runs, 0);
  // Not answering breaks the run of sightings and is never a new version.
  let d = advance(r, o, F("c")).next;
  d = advance(d, o, null).next;
  assert.equal(d.down, true);
  assert.equal(d.candidate, null);
  assert.equal(advance(d, o, F("c")).changed, false, "the count starts again after the app was down");
  // An app with no version to watch is never run by a look.
  const n = advance(undefined, o, F(null, "none"));
  assert.equal(n.next.basis, "none");
  assert.equal(advance(n.next, o, F(null, "none")).changed, false);
});

// ---------- the schedule ----------

test("the look for a new version has its own label, wakes every five minutes, and says so", () => {
  const root = "/Users/me/work/demos-ws";
  const check = labelFor(root, "watch-check");
  assert.match(check, /^app\.retake\.watch-check\.demos-ws\.[0-9a-f]{8}$/);
  assert.notEqual(check, labelFor(root, "watch"));
  assert.notEqual(check, labelFor(root));
  assert.equal(CHECK_EVERY_MIN, 5);
  const spec = { every: "daily" as const, at: "00:00", count: 1, everyMinutes: CHECK_EVERY_MIN };
  const o = { label: check, program: ["/usr/local/bin/node", "/opt/retake/dist/cli.js", "watch", "check", "--scheduled"], root, log: `${root}/.retake/watch-check-schedule.log`, env: { PATH: "/usr/bin:/bin", HOME: "/Users/me" }, spec };
  const xml = plistXml(o);
  assert.match(xml, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.ok(!xml.includes("StartCalendarInterval"), "an interval, not a time of day");
  assert.match(xml, /<string>watch<\/string><string>check<\/string><string>--scheduled<\/string>/);
  if (process.platform === "darwin") {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "retake-plist-")), "x.plist");
    fs.writeFileSync(f, xml);
    assert.equal(spawnSync("plutil", ["-lint", f]).status, 0, "plutil rejects the plist");
  }
  const line = cronLine(o);
  assert.match(line, /^\*\/5 \* \* \* \* cd /);
  assert.ok(line.endsWith(`# ${check}`));
  assert.equal(describeSchedule({ ...spec, kind: "watch-check" }), "every 5 minutes");
  // The nightly one is untouched.
  assert.match(plistXml({ ...o, spec: { every: "daily", at: "03:00", count: 1 } }), /StartCalendarInterval/);
});

test("one switch: `on` is accepted, and where it stands is one line", () => {
  assert.equal(parseWatchSchedule("on", undefined).every, "on");
  assert.equal(parseWatchSchedule("ON", "04:30").at, "04:30");
  assert.throws(() => parseWatchSchedule("hourly", undefined), /say daily, weekdays or off — or on/);
  const yes = { loaded: true, mechanism: "launchd" };
  const on = scheduleStatusLine({ nightly: { when: "every day at 03:00", ...yes }, check: yes, hosts: ["app.example.com"], blind: [] });
  assert.equal(on, "✓ on — every day at 03:00, and whenever app.example.com has a new version (a look every 5 minutes)");
  assert.ok(!on.includes("\n"));
  assert.match(scheduleStatusLine({ nightly: { when: "every day at 03:00", ...yes }, check: yes, hosts: ["a.example.com", "b.example.com"], blind: ["b.example.com"] }),
    /whenever a\.example\.com has a new version .*; b\.example\.com shows no version, so nightly only$/);
  assert.match(scheduleStatusLine({ nightly: { when: "every day at 03:00", ...yes }, check: null, hosts: [], blind: [] }), /nightly only — `retake watch schedule on`/);
  assert.match(scheduleStatusLine({ nightly: null, check: null, hosts: [], blind: [] }), /^off — `retake watch schedule on`/);
  assert.match(scheduleStatusLine({ nightly: { when: "x", loaded: false, mechanism: "launchd" }, check: yes, hosts: [], blind: [] }), /^✗ written, but launchd is not holding it/);
});

// ---------- the words ----------

test("what the window and the notification say about a run a new version started", () => {
  const at = new Date(2026, 10, 25, 14, 2);
  const quiet = lastRunOf([{ status: "unchanged" }, { status: "unchanged" }, { status: "unchanged" }, { status: "unchanged" }, { status: "unchanged" }, { status: "unchanged" }], "deploy", { host: "app.example.com", at });
  assert.equal(ranLine(quiet, at), "Ran at 14:02 because app.example.com changed");
  assert.equal(outcomeWords(quiet), "6 journeys, nothing unexpected");
  assert.equal(ranLine({ ...quiet, trigger: "nightly", at: new Date(2026, 10, 25, 3, 0).toISOString() }, at), "Ran at 03:00 as it does every night");
  assert.equal(ranLine(quiet, new Date(2026, 10, 26, 9, 0)), "Ran yesterday at 14:02 because app.example.com changed");
  assert.equal(outcomeWords({ journeys: 6, changed: 1, failed: 0 }), "1 changed");
  assert.equal(outcomeWords({ journeys: 6, changed: 0, failed: 1 }), "1 failed");
  assert.equal(outcomeWords({ journeys: 6, changed: 1, failed: 1 }), "1 changed, 1 failed");
  // Silent when nothing changed, as at night; named after the app when something did.
  assert.equal(deployNotice("app.example.com", [{ status: "unchanged", title: "Sign in" }]), null);
  assert.deepEqual(deployNotice("app.example.com", [{ status: "unchanged", title: "Sign in" }, { status: "changed", title: "Create a project" }]),
    { title: "Retake Watch", body: "app.example.com has a new version — 1 changed: Create a project" });
  assert.equal(deployNotice("app.example.com", [{ status: "failed", title: "Sign in" }])?.body, "app.example.com has a new version — 1 failed: Sign in");
  const root = workspace();
  writeDeploys(root, { "https://a.example.com": { origin: "https://a.example.com", basis: "none", current: null, candidate: null, checkedAt: "" }, "https://b.example.com": { origin: "https://b.example.com", basis: "assets", current: "x", candidate: null, checkedAt: "" } });
  assert.equal(nightlyOnlyLine(root), "a.example.com shows no version to watch, so it is checked each night only.");
  assert.equal(Object.keys(readDeploys(root)).length, 2);
});

// ---------- the safety gate ----------

test("a journey that changes data runs only where the app is a test space; the question is asked once, word for word", async () => {
  const root = workspace();
  const reads = path.join(root, "watch", "pricing.mjs"), writes = path.join(root, "watch", "create.mjs");
  fs.writeFileSync(reads, `export const url = "https://app.example.com";\nexport default async () => {};\n`);
  fs.writeFileSync(writes, `export const title = "Create a project";\nexport const url = "https://app.example.com/projects";\nexport const changesData = true;\nexport default async () => {};\n`);
  assert.deepEqual(journeyMeta(fs.readFileSync(writes, "utf8")), { url: "https://app.example.com/projects", changesData: true, title: "Create a project", makes: [] });
  assert.equal(journeyMeta(`export const changesData = false;`).changesData, false);
  assert.deepEqual(gate(root, { name: "pricing", file: reads }), { run: true });
  const no = gate(root, { name: "create", file: writes });
  assert.equal(no.run, false);
  assert.match((no as { why: string }).why, /changes data, and app\.example\.com is not marked as a test space/);
  assert.equal(spaceAnswer(root, "https://app.example.com"), null, "nobody asked yet");
  assert.equal(spaceQuestion("https://app.example.com/x"), "Is app.example.com a test space? Journeys that change data run only there.");
  markSpace(root, "https://app.example.com/anything", false);
  assert.equal(gate(root, { name: "create", file: writes }).run, false, "a no is a no");
  markSpace(root, "app.example.com", true);
  assert.equal(gate(root, { name: "create", file: writes }).run, true);
  assert.equal(gate(root, { name: "x", file: path.join(root, "watch", "staging.mjs") }).run, true, "no file, nothing to gate");
  // A data journey that does not say which app: never run.
  const vague = path.join(root, "watch", "vague.mjs");
  fs.writeFileSync(vague, `export const changesData = true;\nexport default async () => {};\n`);
  assert.equal(gate(root, { name: "vague", file: vague }).run, false);

  // Every way of running goes through the gate, and a skip is not a failure.
  markSpace(root, "https://app.example.com", false);
  const ran: string[] = [];
  const fake = async (j: { name: string }): Promise<RunRecord> => { ran.push(j.name); return { journey: j.name, title: j.name, at: "", session: "", dir: "", status: "unchanged", scheduled: true, error: null, steps: 1, changes: [] }; };
  const r = await runBatch({ root, out: path.join(root, "outputs"), journeys: [{ name: "create", file: writes }, { name: "pricing", file: reads }], trigger: "nightly", runner: fake });
  assert.deepEqual(ran, ["pricing"]);
  assert.equal(r.skipped[0].name, "create");
  assert.equal(r.runs.every((x) => x.status !== "failed"), true);
  // And the runner itself refuses, in case anything calls it directly.
  const { runJourney } = await import("../src/watch/journeys.js");
  await assert.rejects(runJourney({ root, name: "create", file: writes, out: path.join(root, "outputs"), ui: false }), /not run — it changes data/);
});

// ---------- proposals ----------

const X: Exploration = {
  origin: "https://app.example.com", entry: "https://app.example.com/", signIn: { url: "https://app.example.com/login" }, signedIn: true,
  pages: [
    { url: "https://app.example.com/login", path: "/login", title: "Sign in", h1: "Sign in", headings: [], links: [], buttons: [], password: true, public: true, name: "Sign in",
      forms: [{ selector: "form", method: "post", fields: [{ selector: 'input[name="email"]', label: "Email", type: "email", name: "email", required: true }, { selector: 'input[name="password"]', label: "Password", type: "password", name: "password", required: true }], submit: { selector: 'button:has-text("Sign in")', text: "Sign in" }, signIn: true, search: false }] },
    { url: "https://app.example.com/projects", path: "/projects", title: "Projects", h1: "Projects", headings: ["Projects"], links: [], buttons: [], password: false, public: false, name: "",
      forms: [{ selector: "form", method: "post", fields: [{ selector: 'input[name="name"]', label: "Project name", type: "text", name: "name", required: true }], submit: { selector: 'button:has-text("New project")', text: "New project" }, signIn: false, search: false }] },
    { url: "https://app.example.com/pricing", path: "/pricing", title: "Pricing", h1: "Pricing", headings: [], links: [], buttons: [], password: false, public: true, name: "Pricing", forms: [] },
  ],
};

test("the model's proposals are read strictly: fenced or bare, malformed ones dropped, writes always marked", () => {
  const answer = "Here you go:\n```json\n" + JSON.stringify([
    { title: "Sign in", checks: "Signs in and lands on Projects.", changes: "reads", steps: [{ do: "signIn" }, { do: "see", text: "Projects" }] },
    // Labelled as reading, but it types and presses Create: it changes data.
    { title: "create a project", checks: "a new project shows in the list", changes: "reads", steps: [{ do: "signIn" }, { do: "open", path: "https://app.example.com/projects" }, { do: "fill", selector: 'input[name="name"]', value: "Watch check" }, { do: "click", selector: 'button:has-text("New project")' }, { do: "see", text: "Watch check" }] },
    { title: "Sign in", checks: "twice", changes: "reads", steps: [{ do: "signIn" }] },                      // the same title again
    { title: "Run a script", checks: "does something", changes: "reads", steps: [{ do: "evaluate", script: "x" }] },  // not a step there is
    { title: "No steps", checks: "nothing", changes: "reads", steps: [] },
    { title: "Check pricing", checks: "", changes: "reads", steps: [{ do: "open", path: "/pricing" }] },       // says nothing it checks
    { title: "Elsewhere", checks: "leaves the app", changes: "reads", steps: [{ do: "open", path: "https://other.example.com/" }] },
  ]) + "\n```\nHope that helps.";
  const got = parseProposals(answer, X);
  assert.deepEqual(got.map((p) => [p.title, p.changes]), [["Sign in", "reads"], ["Create a project", "data"]]);
  assert.equal(got[1].checks, "A new project shows in the list");
  assert.deepEqual(got[1].steps[1], { do: "open", path: "/projects" }, "an address on the app becomes its path");
  // Under "journeys", and never more than eight.
  const many = { journeys: Array.from({ length: 12 }, (_, i) => ({ title: `Page ${i}`, checks: "opens", changes: "reads", steps: [{ do: "open", path: `/p${i}` }, { do: "see", text: "Hi" }] })) };
  assert.equal(parseProposals(JSON.stringify(many)).length, 8);
  assert.deepEqual(parseProposals("I could not look at the app."), []);
  // Nothing made-up is ever typed into the sign-in: those steps become the saved test account.
  const typedIn = parseProposals(JSON.stringify([{ title: "Sign in", checks: "lands on Projects", changes: "data", steps: [
    { do: "open", path: "/login" }, { do: "fill", selector: 'input[name="email"]', value: "watch@example.com" }, { do: "fill", selector: 'input[name="password"]', value: "Watch check" },
    { do: "click", selector: 'button:has-text("Sign in")' }, { do: "see", text: "Projects" }] }]), X);
  assert.deepEqual(typedIn, [{ title: "Sign in", checks: "Lands on Projects", changes: "reads", steps: [{ do: "signIn" }, { do: "see", text: "Projects" }] }]);
  assert.deepEqual(parseProposals("[{\"title\": broken"), []);
  // The rule underneath: typing, choosing, or pressing a button that sends.
  assert.equal(changesData([{ do: "open", path: "/" }, { do: "click", selector: "a:has-text(\"Pricing\")", label: "Pricing" }]), false);
  assert.equal(changesData([{ do: "click", selector: "#go", label: "Invite teammate" }]), true);
  assert.equal(changesData([{ do: "click", selector: 'button:has-text("New project")' }], X), true);
});

test("without a model, the pages themselves are the proposals; writes start unticked because they are marked", () => {
  const ps = plainProposals(X);
  assert.deepEqual(ps.map((p) => [p.title, p.changes]), [["Sign in", "reads"], ["Check the pricing page", "reads"], ["Create a project", "data"]]);
  assert.equal(ps[0].checks, "Signs in with the test account and lands on “Projects”");
  assert.ok(!ps[1].steps.some((s) => s.do === "signIn"), "a public page needs no sign-in");
  assert.ok(ps[2].steps[0].do === "signIn", "a page behind the sign-in starts with it");
  assert.equal(ps.length <= 8, true);
  assert.deepEqual(parsePick("1, 3,3", 3), [1, 3]);
  assert.throws(() => parsePick("4", 3), /pick from 1 to 3/);
  const taken = new Set(["sign-in"]);
  assert.equal(nameFor("Sign in", taken), "sign-in-2");
  assert.equal(nameFor("Check the pricing page", taken), "check-the-pricing-page");
});

test("a journey written from a proposal says which app it is about, whether it writes, and never holds a secret", () => {
  const ps = plainProposals(X);
  const src = journeySource(ps[2], { origin: X.origin, signInUrl: X.signIn!.url, at: new Date("2026-11-25T10:00:00Z") });
  assert.deepEqual(journeyMeta(src), { url: "https://app.example.com", changesData: true, title: "Create a project", makes: ["Watch check"] });
  assert.match(src, /await signIn\(url\);/);
  assert.match(src, /const before = await page\.getByText\("Watch check", \{ exact: true \}\)\.count\(\);/, "it checks one more landed, not that one exists");
  assert.equal((src.match(/w\.step\(/g) ?? []).length, 1, "one step: made, then checked");
  assert.ok(!/password|correct-horse/i.test(src));
  const read = journeySource(ps[1], { origin: X.origin });
  assert.ok(!read.includes("changesData"));
  assert.match(read, /await w\.step\("Open the pricing page", "“Pricing” is on the page"\);/);
});

// ---------- for real, against an app that deploys ----------

const ask = (routes: ReturnType<typeof watchRoutes>) => async (p: string, method = "GET", payload: unknown = {}) => {
  let body = "", code = 0;
  const res = { headersSent: false, writeHead: (c: number) => { code = c; }, end: (b?: string) => { body = b ?? ""; } } as unknown as http.ServerResponse;
  await routes.handleApi({ method } as http.IncomingMessage, res, new URL(p, "http://x"), p, async () => JSON.stringify(payload));
  return { code, json: JSON.parse(body) };
};

test("from an address to watched journeys, a deploy noticed by itself, and silence when nothing changed", { timeout: 600_000 }, async () => {
  const app = await startFernway();
  const root = workspace();
  const out = path.join(root, "outputs");
  const was = process.env.RETAKE_LOGIN_FILE;
  process.env.RETAKE_LOGIN_FILE = path.join(root, "logins.json");
  try {
    const { saveLogin } = await import("../src/logins.js");
    const { explore, keepSuggestion } = await import("../src/watch/suggest.js");
    // Before a test account: the sign-in is found, and what is behind it is not seen.
    const outside = await explore(app.url);
    assert.ok(outside.signIn?.url.endsWith("/login"));
    assert.equal(outside.signedIn, false);
    saveLogin(new URL(app.url).host, ACCOUNT);
    const x = await explore(app.url);
    assert.equal(x.signedIn, true);
    const ps = plainProposals(x);
    assert.ok(ps.length >= 4 && ps.length <= 8, ps.map((p) => p.title).join(", "));
    const titles = ps.map((p) => p.title);
    for (const t of ["Sign in", "Check the pricing page", "Check the team page", "Create a project", "Invite a teammate"]) assert.ok(titles.includes(t), `${t} in ${titles.join(", ")}`);
    const s: Suggestion = { origin: x.origin, at: "", by: "the pages", signIn: x.signIn, signedIn: true, proposals: ps };
    keepSuggestion(root, s);
    const n = (t: string) => titles.indexOf(t) + 1;

    // A data journey on an app nobody marked: not added, and one sentence why.
    const refused = await addJourneys({ root, out, suggestion: s, pick: [n("Create a project")] });
    assert.deepEqual(refused, [{ title: "Create a project", added: false, why: `It changes data, and ${new URL(app.url).host} is not marked as a test space.` }]);
    // Two of them, added: each ran once, and that run is its normal.
    const added = await addJourneys({ root, out, suggestion: s, pick: [n("Sign in"), n("Check the pricing page")] });
    assert.deepEqual(added.map((a) => [a.title, a.added]), [["Sign in", true], ["Check the pricing page", true]], JSON.stringify(added));
    assert.ok(fs.existsSync(path.join(root, "watch", "sign-in.mjs")));
    assert.ok(fs.existsSync(path.join(root, "watch", ".journeys", "sign-in", "baseline", "snapshots.json")));
    const src = fs.readFileSync(path.join(root, "watch", "sign-in.mjs"), "utf8");
    assert.ok(!src.includes(ACCOUNT.password) && !src.includes(ACCOUNT.user), "no secret in the file");

    // The light check. Count what it runs, and what it says.
    let ranCount = 0;
    const notices: string[] = [];
    const { runJourney } = await import("../src/watch/journeys.js");
    const runner = (j: { name: string; file: string }) => { ranCount++; return runJourney({ root, name: j.name, file: j.file, out, scheduled: true, ui: false }); };
    const check = () => checkForDeploys({ root, out, scheduled: true, runner, notify: (t, b) => notices.push(`${t}: ${b}`) });

    let r = (await check())!;
    assert.equal(r.length, 1, "one app");
    assert.equal(r[0].state.basis, "assets");
    assert.equal(r[0].changed, false, "the first look is what is deployed now");
    r = (await check())!;
    assert.equal(r[0].changed, false);
    assert.equal(ranCount, 0, "no change: nothing runs");

    // A deploy: new file names, and the button on the page after signing in says something else.
    app.deploy({ label: "Create project" });
    r = (await check())!;
    assert.equal(r[0].changed, false, "seen once: the app may still be settling");
    assert.equal(ranCount, 0);
    r = (await check())!;
    assert.equal(r[0].changed, true, "seen twice: it runs");
    assert.equal(ranCount, 2, "that app's journeys, both");
    const runs = r[0].runs!;
    assert.deepEqual(runs.map((x) => [x.journey, x.status]).sort(), [["check-the-pricing-page", "unchanged"], ["sign-in", "changed"]]);
    assert.deepEqual(notices, [`Retake Watch: ${new URL(app.url).host} has a new version — 1 changed: Sign in`]);
    r = (await check())!;
    assert.equal(r[0].changed, false);
    assert.equal(ranCount, 2, "once per version");

    // The window says what started it.
    const routes = watchRoutes({ root, outRoot: () => out, token: "t", activity: () => {} });
    const J = (await ask(routes)("/api/watch/journeys")).json;
    assert.match(J.ran, new RegExp(`^Ran at \\d\\d:\\d\\d because ${new URL(app.url).host.replace(/\./g, "\\.")} changed\\.$`));
    assert.match(J.summary, /^1 journey changed/);
    assert.equal(J.blind, null);

  } finally {
    await app.close();
    if (was === undefined) delete process.env.RETAKE_LOGIN_FILE; else process.env.RETAKE_LOGIN_FILE = was;
  }
});

test("a journey that cannot pass its first run is not added; one that changes data, on a test space, stays unchanged run after run", { timeout: 600_000 }, async () => {
  const app = await startFernway();
  const root = workspace();
  const out = path.join(root, "outputs");
  const was = process.env.RETAKE_LOGIN_FILE;
  process.env.RETAKE_LOGIN_FILE = path.join(root, "logins.json");
  try {
    const { saveLogin } = await import("../src/logins.js");
    const { explore } = await import("../src/watch/suggest.js");
    const { runJourney } = await import("../src/watch/journeys.js");
    saveLogin(new URL(app.url).host, ACCOUNT);
    const x = await explore(app.url);
    const ps = plainProposals(x);
    const s: Suggestion = { origin: x.origin, at: "", by: "the pages", signIn: x.signIn, signedIn: true, proposals: ps };
    // A journey that cannot pass its first run is not added either.
    const broken: Suggestion = { ...s, proposals: [{ title: "Check the reports page", checks: "Reports open", changes: "reads", steps: [{ do: "signIn" }, { do: "open", path: "/projects" }, { do: "see", text: "Quarterly reports" }] }] };
    const [no] = await addJourneys({ root, out, suggestion: broken, pick: [1] });
    assert.equal(no.added, false);
    assert.match(no.why!, /^It did not pass its first run: “Open \/projects” failed/);
    assert.equal(fs.existsSync(path.join(root, "watch", "check-the-reports-page.mjs")), false);
    assert.equal(fs.existsSync(path.join(root, "watch", ".journeys", "check-the-reports-page")), false, "nothing of it is left behind");


    const routes = watchRoutes({ root, outRoot: () => out, token: "t", activity: () => {} });
    // A data journey, once the person says this is a test space: it runs, and a
    // second run is unchanged even though the list it adds to has grown.
    const yes = await ask(routes)("/api/watch/spaces", "POST", { url: app.url, test: true });
    assert.equal(yes.json.test, true);
    const [made] = await addJourneys({ root, out, suggestion: s, pick: [ps.findIndex((p) => p.title === "Create a project") + 1] });
    assert.equal(made.added, true, made.why);
    const again = await runJourney({ root, name: made.name!, file: path.join(root, "watch", `${made.name}.mjs`), out, ui: false });
    assert.equal(again.status, "unchanged", JSON.stringify(again.changes));
    assert.ok(app.state.projects.filter((p: string) => p === "Watch check").length >= 2, "it really made one each time");
  } finally {
    await app.close();
    if (was === undefined) delete process.env.RETAKE_LOGIN_FILE; else process.env.RETAKE_LOGIN_FILE = was;
  }
});

test("an app with no hashed files and no version: the look says so, and it stays nightly", { timeout: 60_000 }, async () => {
  const app = await startFernway({ hashed: false });
  try {
    const f = await observe(app.url);
    assert.equal(f?.basis, "none");
    assert.equal(f?.id, null);
    const root = workspace();
    fs.writeFileSync(path.join(root, "watch", "pricing.mjs"), `export const url = ${JSON.stringify(app.url)};\nexport default async () => {};\n`);
    let ran = 0;
    const runner = async (j: { name: string }): Promise<RunRecord> => { ran++; return { journey: j.name, title: j.name, at: "", session: "", dir: "", status: "unchanged", scheduled: true, error: null, steps: 1, changes: [] }; };
    await checkForDeploys({ root, out: path.join(root, "outputs"), runner });
    app.deploy({ plan: "Teams" });
    await checkForDeploys({ root, out: path.join(root, "outputs"), runner });
    await checkForDeploys({ root, out: path.join(root, "outputs"), runner });
    assert.equal(ran, 0);
    assert.equal(nightlyOnlyLine(root), `${new URL(app.url).host} shows no version to watch, so it is checked each night only.`);
    // And an app that is not answering is not a new version.
    assert.equal(await observe("http://127.0.0.1:9"), null);
  } finally { await app.close(); }
});
