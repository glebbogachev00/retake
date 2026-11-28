/** A Watch run as one page you can send to someone: a client, a partner.

    `retake watch share <project|journey|session|all>` builds it from what
    Watch already keeps. The page says how things stand in one line, then
    shows one thing at a time, in the window's order: what needs a look
    first (journeys stopped by the same missing sign-in are one item), then
    the rest. A list of every one sits beside it (a sheet on a phone), so any
    journey is one click away. Each has a picture of its problem, its replay (loaded only when
    it is the one on screen, and paced like the window's: a hold at each
    step's end), and its steps with pass or fail. Next moves on, or pick one
    in the list; the address keeps the place, so a link can point at one.

    The page holds only videos, pictures and text. No token, no login, no
    address of the window, and none of the person's notes unless they ask
    for them (`notes`). The pictures and videos are the session's own, so
    whatever a journey masked is still masked. It is a folder under
    `<outputs>/.shares/<name>/`, served by the same server as the demo
    shares (src/share.ts); who else can reach it is the person's call. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brandCss, markFavicon, markSvg } from "../brand.js";
import { shareRoot, tailscaleHint } from "../share.js";
import { describeChange } from "./compare.js";
import { groupByApp } from "./deploys.js";
import {
  baselineDir, listJourneys, momentOf, problemOf, readBaseline, readLast, readSnapshots, shortDate, summaryLine, whenWord, type RunRecord,
} from "./journey-store.js";
import { groupName } from "./names.js";
import { listProjects, projectOfJourney } from "./projects.js";
import { readFlagsIn, readMeta, readSteps, safeId } from "./session.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = /^[a-z0-9][a-z0-9-]*$/;

export type WatchShareStep = { n: number; scenario: string | null; intent: string; expect: string; result: "pass" | "fail" | null; note: string; t: number; tEnd: number | null };
/** One thing the page shows at a time. */
export type WatchShareItem = {
  kind: "signin" | "failed" | "changed" | "fine";
  title: string;
  /** The title inside its group, with the group's name taken off. */
  short: string;
  group: string | null;
  /** "Failed yesterday at 21:21", "Unchanged since 25 Nov". */
  line: string;
  /** One plain line on what is wrong. */
  reason: string | null;
  /** A missing sign-in: the journeys that need it. */
  journeys?: string[];
  pictures: { label: string; src: string; box?: { x: number; y: number; width: number; height: number } | null }[];
  added?: string[]; removed?: string[];
  video: string | null;
  poster: string | null;
  start: number;
  steps: WatchShareStep[];
  notes: { step: number | null; text: string }[];
};
export type WatchShare = { name: string; dir: string; title: string; items: WatchShareItem[] };

type Target = { journey: string | null; session: string; dir: string; last: RunRecord | null };

/** What a share can be of: every journey, a project, one journey's last run, or one session. */
export function watchShareTargets(root: string, outRoot: string, what: string): Target[] {
  const all = listJourneys(root);
  const run = (name: string): Target | null => {
    const last = readLast(root, name);
    return last?.dir && fs.existsSync(path.join(last.dir, "session.json")) ? { journey: name, session: last.session, dir: last.dir, last } : null;
  };
  const runs = (names: string[], none: string) => {
    const got = names.map(run).filter((x): x is Target => !!x);
    if (!got.length) throw new Error(none);
    return got;
  };
  if (what === "all") return runs(all.map((j) => j.name), "no journey has run yet — `retake watch run all` first");
  if (all.some((j) => j.name === what)) return runs([what], `"${what}" has not run yet — \`retake watch run ${what}\` first`);
  const project = listProjects(root).find((p) => p.id === what);
  if (project) return runs(project.journeys, `nothing in "${project.name}" has run yet — \`retake watch run ${what}\` first`);
  if (safeId(what)) {
    const dir = path.join(outRoot, "watch", what);
    if (fs.existsSync(path.join(dir, "session.json"))) {
      // A session a journey made says so; it then shares as that journey's run.
      const j = all.find((x) => readLast(root, x.name)?.session === what);
      return [{ journey: j?.name ?? null, session: what, dir, last: j ? readLast(root, j.name) : null }];
    }
  }
  throw new Error(`"${what}" is not a project, a journey or a session — \`retake watch journeys\` and \`retake watch sessions\` list them`);
}

export function buildWatchShare(o: { root: string; outRoot: string; what: string; name?: string; title?: string; by?: string; notes?: boolean; now?: Date }): WatchShare {
  const now = o.now ?? new Date();
  const targets = watchShareTargets(o.root, o.outRoot, o.what);
  const name = o.name ?? (o.what === "all" ? "watch" : `watch-${o.what}`).slice(0, 64);
  if (!NAME.test(name)) throw new Error("the share name must be kebab-case");

  // Built fresh every time: a run dropped from the page must not linger in
  // the folder, where anyone with the link could still fetch it.
  const dir = path.join(shareRoot(o.outRoot), name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "v"), { recursive: true });
  let k = 0;
  const copy = (from: string | null | undefined, kind: string): string | null => {
    if (!from || !fs.existsSync(from)) return null;
    const as = `${String(++k).padStart(3, "0")}-${kind}${path.extname(from)}`;
    fs.copyFileSync(from, path.join(dir, "v", as));
    return `v/${as}`;
  };

  // Groups: projects when the page spans several; within one, its sites, only when it has more than one.
  const projects = listProjects(o.root);
  const named = targets.filter((t) => t.journey);
  const titles = new Map(named.map((t) => [t.journey!, readMeta(t.dir)?.title ?? t.last?.title ?? t.journey!]));
  const groupOf = new Map<string, { name: string; short: (t: string) => string }>();
  const spans = new Set(named.map((t) => projectOfJourney(projects, t.journey!)?.id ?? ""));
  if (spans.size > 1) {
    for (const p of projects) {
      const mine = named.filter((t) => p.journeys.includes(t.journey!));
      const g = groupName(mine.map((t) => titles.get(t.journey!)!), null);
      for (const t of mine) groupOf.set(t.journey!, { name: p.name, short: g.short });
    }
  } else {
    const sites = groupByApp(o.root, named.map((t) => ({ name: t.journey! })));
    for (const s of sites) {
      // Named from the journeys listed under it; those needing a look are listed first, on their own.
      const quiet = s.items.filter((i) => { const st = readLast(o.root, i.name)?.status; return st !== "failed" && st !== "changed"; });
      const g = groupName((quiet.length ? quiet : s.items).map((i) => titles.get(i.name)!), s.host);
      for (const i of s.items) groupOf.set(i.name, sites.length > 1 ? g : { name: projects.find((p) => p.journeys.includes(i.name))?.name ?? g.name, short: g.short });
    }
  }

  const lower = (t: string) => t.replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase());
  const each = targets.map((t) => {
    const meta = readMeta(t.dir);
    const steps = readSteps(t.dir);
    const last = t.last && t.last.session === t.session ? t.last : null;
    const baseline = t.journey ? readBaseline(o.root, t.journey) : null;
    const status = last?.status ?? null;
    const title = meta?.title ?? last?.title ?? t.session;
    const g = t.journey ? groupOf.get(t.journey) : undefined;
    const line = last
      ? status === "failed" ? `Failed ${whenWord(last.at, now)}` : status === "changed" ? `Changed ${whenWord(last.at, now)}` : `Unchanged since ${shortDate(baseline?.acceptedAt ?? last.at, now)}`
      : meta ? `Ran ${whenWord(meta.startedAt, now)}` : "";
    const moment = last ? momentOf(last, baseline, readSnapshots(t.dir), steps) : null;
    const failedStep = steps.find((s) => s.result === "fail");
    const problem = problemOf((failedStep?.note || last?.error || meta?.problem || "").trim());
    const kind: WatchShareItem["kind"] = status === "failed" || (!last && failedStep) ? (problem.signIn ? "signin" : "failed") : status === "changed" ? "changed" : "fine";
    const item: WatchShareItem = {
      kind, title, short: g ? g.short(title) : title, group: g?.name ?? null, line, reason: null, pictures: [], video: null, poster: null, start: 0,
      // A failed step's note can carry a command meant for the person who runs it; the page says it plainly.
      steps: steps.map((s) => ({ n: s.n, scenario: s.scenario, intent: s.intent, expect: s.expect, result: s.result, note: s.result === "fail" ? problemOf(s.note).broke : s.note, t: s.t, tEnd: s.tEnd })),
      notes: o.notes ? readFlagsIn(t.dir).filter((f) => f.note.trim()).map((f) => ({ step: f.step, text: f.note.trim() })) : [],
    };
    if (kind === "signin") item.reason = problem.broke;
    if (kind === "failed") {
      item.reason = failedStep ? `“${failedStep.intent}” failed${problem.broke ? `: ${lower(problem.broke)}` : "."}` : problem.broke || "It did not finish.";
      const pic = copy(failedStep?.screenshot ? path.join(t.dir, failedStep.screenshot) : null, "stopped");
      if (pic) item.pictures.push({ label: "Where it stopped", src: pic });
    }
    if (kind === "changed" && last?.changes.length && moment) {
      const c = last.changes[0];
      item.reason = `“${c.intent}”: ${lower(describeChange(c))}.`;
      item.added = c.text?.added.slice(0, 4) ?? []; item.removed = c.text?.removed.slice(0, 4) ?? [];
      const normal = copy(moment.before && t.journey ? path.join(baselineDir(o.root, t.journey), moment.before) : null, "normal");
      const fresh = copy(moment.after ? path.join(t.dir, moment.after) : null, "new");
      if (normal) item.pictures.push({ label: "Normal", src: normal });
      if (fresh) item.pictures.push({ label: "This run", src: fresh, box: moment.box });
    }
    // A missing sign-in stopped it before anything was on screen: no replay to show.
    if (kind !== "signin" && meta?.video) {
      item.video = copy(path.join(t.dir, meta.video), "replay");
      const shot = (kind === "failed" ? failedStep?.screenshot : null) ?? [...steps].reverse().find((s) => s.screenshot)?.screenshot ?? null;
      item.poster = item.video ? (item.pictures.find((p) => p.label !== "Normal")?.src ?? copy(shot ? path.join(t.dir, shot) : null, "poster")) : null;
      item.start = moment?.clip ? moment.clip.start : 0;
    }
    return { item, site: problem.signIn ? new URL(problem.signIn).host : null, at: last?.at ?? meta?.startedAt ?? "" };
  });

  // In the window's order: failures (those sharing a missing sign-in as one), changes, then the rest.
  const items: WatchShareItem[] = [];
  const bySite = new Map<string, WatchShareItem>();
  for (const e of each.filter((x) => x.item.kind === "signin" || x.item.kind === "failed")) {
    if (e.item.kind === "signin" && e.site) {
      const had = bySite.get(e.site);
      if (had) { had.journeys!.push(e.item.title); continue; }
      const card: WatchShareItem = { ...e.item, journeys: [e.item.title] };
      bySite.set(e.site, card); items.push(card);
    } else items.push(e.item);
  }
  for (const [site, c] of bySite) if (c.journeys!.length > 1) {
    const word = site.replace(/:\d+$/, "").split(".").filter((x) => !/^(www|login|auth|app)$/.test(x))[0] ?? site;
    c.title = `${c.journeys!.length} journeys need the ${word} sign-in`; c.short = c.title; c.group = null;
  }
  items.push(...each.filter((x) => x.item.kind === "changed").map((x) => x.item));
  const fine = each.filter((x) => x.item.kind === "fine").map((x) => x.item);
  const order = [...new Set(fine.map((i) => i.group))];
  items.push(...fine.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group)));

  const journeys = targets.filter((t) => t.last && t.last.session === t.session).map((t) => t.last);
  const title = o.title ?? (targets.length === 1 ? items[0].title : summaryLine(journeys, now) ?? "Everything looks the same as normal");
  const ran = each.map((e) => e.at).filter(Boolean).sort();
  fs.writeFileSync(path.join(dir, "index.html"), watchSharePage({ title, by: o.by, items, from: ran[0], to: ran.at(-1) }));
  return { name, dir, title, items };
}

/** What to tell the person once the page is built: the same, true thing
    the demo share says about who can open the link. */
export function watchShareReport(s: WatchShare, url: string, port: number, o: { notes?: boolean } = {}): string[] {
  const hint = tailscaleHint(port);
  return [
    `✓ share "${s.title}" · ${s.items.length} on the page · ${path.relative(process.cwd(), s.dir) || s.dir}`,
    `  ${url}`,
    o.notes ? "  Your notes on these runs are on the page." : "  Your notes are not on the page (--notes puts them there).",
    "  This link opens on this Mac only.",
    hint
      ? `  For your other devices on your Tailscale network: ${hint}  (then the link is https://<this-mac>.<tailnet>.ts.net:8449/${s.name}/)`
      : "  To send it to someone else, share the folder above, or put it behind a server you control.",
  ];
}

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dateWords = (iso?: string) => iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "";

/** The window's replay pacer (src/ui/watch.html, <script id="pacer">), so the page plays a run the same way. */
export function pacerSource(): string {
  const html = fs.readFileSync(path.join(HERE, "..", "ui", "watch.html"), "utf8");
  const m = /<script id="pacer">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("the window's replay pacer is missing from watch.html");
  return m[1];
}

/** The page. Every word on it came from a test script or the app: it goes in
    as JSON and onto the page escaped, never as markup. */
export function watchSharePage(o: { title: string; by?: string; items: WatchShareItem[]; from?: string; to?: string }): string {
  const data = JSON.stringify(o.items).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
  const when = o.from ? (dateWords(o.from) === dateWords(o.to) || !o.to ? dateWords(o.from) : `${dateWords(o.from)} – ${dateWords(o.to)}`) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(o.title)} · Retake Watch</title>
${markFavicon()}
<style>
${brandCss()}
  * { box-sizing:border-box; } html, body { margin:0; }
  body { background:var(--paper); color:var(--ink); font:15px/1.55 var(--sans); -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; } button { font:inherit; color:inherit; }
  .wrap { width:min(1080px, calc(100% - 40px)); margin-inline:auto; }
  .rt-top { position:static; }
  .rt-top .by { font-size:13px; color:var(--muted); }
  .intro { padding:40px 0 26px; display:grid; gap:10px; }
  h1 { margin:0; font-size:clamp(28px, 3.6vw, 42px); font-weight:500; line-height:1.12; letter-spacing:-.045em; text-wrap:balance; overflow-wrap:anywhere; }
  .when { margin:0; color:var(--muted); font-size:13px; }
  .item { display:grid; gap:10px; padding-top:18px; border-top:1px solid var(--line); }
  .status { margin:0; font-size:13px; color:var(--muted); }
  .status.failed, .status.signin { color:var(--fail); } .status.changed { color:var(--amber-ink); }
  .item h2 { margin:0; font-size:clamp(22px, 2.4vw, 28px); font-weight:500; letter-spacing:-.03em; line-height:1.2; overflow-wrap:anywhere; }
  .item .group { color:var(--muted); }
  .reason { margin:0; max-width:70ch; }
  .who { margin:0; padding-left:18px; color:var(--muted); font-size:13px; }
  .diff { font:12.5px/1.7 var(--mono); }
  .diff .gone { color:var(--muted); text-decoration:line-through; } .diff .new::before { content:"+ "; color:var(--pass); }
  .pair { display:grid; grid-template-columns:repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap:20px; margin-top:12px; align-items:start; }
  .pair figure, .player figure { margin:0; }
  .pic { position:relative; display:flex; justify-content:center; background:var(--soft); }
  .pic .holder { position:relative; display:inline-block; max-width:100%; }
  .pic img { display:block; max-width:100%; max-height:56vh; }
  .pic .box { position:absolute; outline:2px solid var(--amber); outline-offset:1px; border-radius:3px; }
  .player { margin-top:12px; }
  .player video { display:block; width:100%; max-height:62vh; background:var(--soft); object-fit:contain; }
  .controls { display:flex; gap:10px; align-items:center; margin-top:10px; }
  .pp { min-height:34px; padding:6px 12px; gap:7px; }
  .rate { font:12px var(--mono); color:var(--ink); background:var(--panel); border:1px solid var(--line-dark); border-radius:6px; height:34px; padding:0 6px; }
  .track { position:relative; flex:1; height:30px; cursor:pointer; touch-action:none; }
  .track .bar { position:absolute; left:0; right:0; top:13px; height:3px; border-radius:2px; background:var(--line-dark); }
  .track .done { position:absolute; left:0; top:13px; height:3px; border-radius:2px; background:var(--ink); opacity:.5; }
  .track .mark { position:absolute; top:7px; width:2px; height:15px; margin-left:-1px; border-radius:1px; background:var(--faint); }
  .track .mark.fail { background:var(--fail); width:3px; }
  .track .head { position:absolute; top:4px; width:2px; height:22px; margin-left:-1px; background:var(--rec); }
  .nowline { margin:8px 0 0; min-height:1.5em; font-size:14px; }
  .nowline b.pass { color:var(--pass); } .nowline b.fail { color:var(--fail); }
  ol.steps { list-style:none; margin:16px 0 0; padding:0; columns:2 360px; column-gap:40px; }
  ol.steps li { break-inside:avoid; font-size:13px; }
  ol.steps .row { display:flex; gap:11px; align-items:flex-start; padding:7px 0; border-bottom:1px dashed var(--line); }
  ol.steps .h { display:block; font:10.5px/1.6 var(--mono); letter-spacing:.07em; text-transform:uppercase; color:var(--muted); padding:12px 0 4px; }
  ol.steps .m { width:16px; height:16px; flex:none; border-radius:50%; display:inline-grid; place-items:center; margin-top:1px; font:700 9px/1 var(--sans); color:var(--on-ink); border:1px solid var(--line-dark); }
  ol.steps li.pass .m { background:var(--pass); border-color:var(--pass); }
  ol.steps li.fail .m { background:var(--fail); border-color:var(--fail); }
  ol.steps li.fail { color:var(--fail); }
  ol.steps .n { display:block; color:var(--muted); }
  .notes { margin-top:14px; padding:12px 16px; background:var(--amber-soft); border:1px solid var(--line-dark); border-radius:10px; font-size:14px; }
  .notes ul { margin:4px 0 0; padding-left:18px; }
  /* The list: every journey, always there on a wide screen, a sheet on a phone. */
  .layout { display:grid; grid-template-columns:280px minmax(0, 1fr); gap:44px; align-items:start; }
  .list { position:sticky; top:16px; max-height:calc(100vh - 32px); overflow:auto; padding:4px 0 12px; border-right:1px solid var(--line); }
  .list p { margin:16px 12px 6px 0; font-size:12px; color:var(--muted); }
  .list p:first-child { margin-top:4px; }
  .list ol { list-style:none; margin:0; padding:0; }
  .list button { position:relative; display:flex; gap:9px; align-items:baseline; width:100%; text-align:left; border:0; background:none; padding:7px 12px 7px 10px; font-size:14px; line-height:1.35; color:var(--ink); cursor:pointer; border-radius:0 6px 6px 0; }
  .list button:hover { background:var(--soft); }
  .list button.fine { color:var(--muted); }
  .list button[aria-current="true"] { background:var(--tint); color:var(--ink); }
  .list button[aria-current="true"]::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--amber); }
  .list button:focus-visible { outline:2px solid var(--amber-ink); outline-offset:-2px; }
  .list .k { flex:none; width:12px; font-size:11px; font-weight:700; text-align:center; }
  .list .k.failed, .list .k.signin { color:var(--fail); } .list .k.changed { color:var(--amber-ink); } .list .k.fine { color:var(--pass); font-weight:400; }
  .where { display:none; }
  .pager { display:flex; justify-content:flex-end; align-items:center; gap:14px; margin:22px 0 0; }
  .pager .quiet { font-size:13px; color:var(--muted); margin-right:auto; }
  .pager .count { font:12px var(--mono); color:var(--muted); }
  .sheet-bg { display:none; }
  @media (max-width: 999px) {
    .layout { grid-template-columns:minmax(0, 1fr); gap:0; }
    .where { display:flex; justify-content:flex-end; margin:0 0 12px; }
    .where button { border:1px solid var(--line-dark); background:var(--panel); color:var(--ink); border-radius:6px; padding:7px 12px; font:12px var(--mono); cursor:pointer; }
    .list { position:fixed; left:0; right:0; bottom:0; top:auto; z-index:20; max-height:72vh; border:1px solid var(--line-dark); border-bottom:0; border-radius:14px 14px 0 0; background:var(--panel); box-shadow:var(--shadow); padding:10px 8px 24px; transform:translateY(105%); visibility:hidden; }
    body.sheet .list { transform:none; visibility:visible; }
    body.sheet .sheet-bg { display:block; position:fixed; inset:0; z-index:19; background:rgba(21,21,18,.32); }
  }
  @media (max-width: 999px) and (prefers-reduced-motion: no-preference) { .list { transition:transform .2s ease, visibility .2s; } }
  footer { border-top:1px solid var(--line); margin-top:48px; padding:22px 0 32px; display:flex; flex-wrap:wrap; gap:10px 24px; align-items:center; font-size:12px; color:var(--muted); }
  footer .rt-brand { font-size:15px; }
  footer a.site { margin-left:auto; font-family:var(--mono); }
  @media (max-width: 560px) { footer a.site { margin-left:0; } .pager { flex-wrap:wrap; } .pager .quiet { flex-basis:100%; } }
</style>
</head>
<body>
<header class="rt-top"><a class="rt-brand" href="https://www.useretake.app">${markSvg(26)}<span>Retake</span></a><span class="rt-sp"></span>${o.by ? `<span class="by">Shared with you by ${esc(o.by)}</span>` : ""}</header>
<main class="wrap">
  <section class="intro">
    <span class="rt-label">Retake Watch</span>
    <h1>${esc(o.title)}</h1>
    ${when ? `<p class="when">${esc(when)}</p>` : ""}
  </section>
  <div class="layout">
    <nav class="list" id="list" aria-label="Every journey on this page"></nav>
    <div class="col">
      <div class="where"><button type="button" id="all" aria-controls="list" aria-expanded="false"></button></div>
      <section class="item" id="item" aria-live="polite"></section>
      <div class="pager"><span class="quiet" id="quiet"></span><span class="count" id="count"></span><button class="rt-btn go" id="next" type="button">Next</button></div>
    </div>
  </div>
</main>
<div class="sheet-bg" id="sheetbg"></div>
<footer class="wrap"><span class="rt-brand">${markSvg(20)}<span>Retake</span></span><span>Every run is a real browser, driven by a script.</span><a class="site" href="https://www.useretake.app">useretake.app</a></footer>
<script>${pacerSource()}</script>
<script>
const V = ${data};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const loud = (v) => v.kind !== "fine";
let at = 0, pace = null, rate = savedRate();
const fromHash = () => { const n = parseInt(location.hash.slice(1), 10); return n >= 1 && n <= V.length ? n - 1 : 0; };
const win = (label, body) => '<figure class="rt-win"><div class="rt-win-top"><span class="rt-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="rt-label">' + esc(label) + "</span></div>" + body + "</figure>";
const pic = (p) => '<div class="pic"><span class="holder"><img src="' + esc(p.src) + '" alt="' + esc(p.label) + '">' + (p.box ? '<span class="box" style="left:' + p.box.x * 100 + "%;top:" + p.box.y * 100 + "%;width:" + p.box.width * 100 + "%;height:" + p.box.height * 100 + '%"></span>' : "") + "</span></div>";
function show(i) {
  at = i;
  const v = V[i];
  let h = '<p class="status ' + v.kind + '">' + esc(v.line) + (v.group ? ' <span class="group">· ' + esc(v.group) + "</span>" : "") + "</p><h2>" + esc(v.group && !loud(v) ? v.short : v.title) + "</h2>";
  if (v.reason) h += '<p class="reason">' + esc(v.reason) + "</p>";
  if (v.journeys && v.journeys.length > 1) h += '<ul class="who">' + v.journeys.map((t) => "<li>" + esc(t) + "</li>").join("") + "</ul>";
  if ((v.removed && v.removed.length) || (v.added && v.added.length)) h += '<div class="diff">' + (v.removed || []).map((t) => '<div class="gone">' + esc(t) + "</div>").join("") + (v.added || []).map((t) => '<div class="new">' + esc(t) + "</div>").join("") + "</div>";
  if (v.pictures.length) h += '<div class="pair">' + v.pictures.map((p) => win(p.label, pic(p))).join("") + "</div>";
  // The replay exists only while it is the one on screen.
  if (v.video) h += '<div class="player">' + win("Replay", '<video id="vid" muted playsinline preload="metadata"' + (v.poster ? ' poster="' + esc(v.poster) + '"' : "") + ' src="' + esc(v.video) + "#t=" + v.start.toFixed(2) + '"></video>') +
    '<div class="controls"><button class="rt-btn pp" id="playpause" type="button" aria-pressed="true">' + playPause(true) + '</button><div class="track" id="track"><div class="bar"></div><div class="done" id="done"></div><div id="marks"></div><div class="head" id="head"></div></div><select class="rate" id="rate" title="Speed" aria-label="Speed">' + RATES.map((r) => '<option value="' + r + '"' + (r === rate ? " selected" : "") + ">" + r + "×</option>").join("") + '</select></div><p class="nowline" id="nowline"></p></div>';
  let scen;
  const steps = v.steps.map((s) => { const head = s.scenario !== scen && s.scenario ? '<span class="h">' + esc(s.scenario) + "</span>" : ""; scen = s.scenario; return '<li class="' + (s.result || "open") + '">' + head + '<span class="row"><span class="m">' + (s.result === "pass" ? "✓" : s.result === "fail" ? "✕" : "") + "</span><span>" + esc(s.intent) + (s.note ? '<span class="n">' + esc(s.note) + "</span>" : "") + "</span></span></li>"; }).join("");
  if (steps && v.kind !== "signin") h += '<ol class="steps">' + steps + "</ol>";
  if (v.notes.length) h += '<div class="notes"><span class="rt-label">Notes</span><ul>' + v.notes.map((n) => "<li>" + (n.step ? "Step " + n.step + ": " : "") + esc(n.text) + "</li>").join("") + "</ul></div>";
  $("item").innerHTML = h;
  $("count").textContent = i + 1 + " of " + V.length;
  $("all").textContent = i + 1 + " of " + V.length + " · All ▾";
  document.querySelectorAll("#list button").forEach((b) => b.setAttribute("aria-current", String(+b.dataset.i === i)));
  const cur = document.querySelector('#list button[data-i="' + i + '"]'); if (cur) cur.scrollIntoView({ block: "nearest" });
  $("next").disabled = i + 1 >= V.length;
  $("quiet").textContent = loud(v) && V[i + 1] && !loud(V[i + 1]) ? "Nothing else needs a look" : "";
  const vid = $("vid");
  function line() {
    const vd = $("vid"); if (!vd) return;
    const ms = vd.currentTime * 1000;
    let s = null; for (const x of v.steps) if (x.t <= ms) s = x;
    if (vd.duration) { const p = Math.min(100, vd.currentTime / vd.duration * 100) + "%"; $("head").style.left = p; $("done").style.width = p; }
    const pb = $("playpause"), paused = !(pace && pace.playing());
    if (pb.getAttribute("aria-pressed") !== String(paused)) { pb.innerHTML = playPause(paused); pb.setAttribute("aria-pressed", String(paused)); }
    if (!s) { $("nowline").textContent = ""; return; }
    const done = s.result && (s.tEnd == null || ms >= s.tEnd - 20);
    $("nowline").innerHTML = esc(s.intent) + (done ? ' — <b class="' + s.result + '">' + (s.result === "pass" ? "Passed" : "Failed") + "</b>" + (s.note ? " " + esc(s.note) : "") : "");
  }
  if (vid) {
    vid.playbackRate = rate;
    pace = pacer(vid, () => v.steps, { onHold: line });
    for (const ev of ["timeupdate", "play", "pause"]) vid.addEventListener(ev, line);
    vid.addEventListener("loadedmetadata", () => {
      vid.playbackRate = rate;
      const d = vid.duration, pct = (ms) => Math.min(100, ms / 1000 / d * 100) + "%";
      $("marks").innerHTML = v.steps.map((s) => '<div class="mark' + (s.result === "fail" ? " fail" : "") + '" style="left:' + pct(s.t) + '"></div>').join("");
      line();
    });
    $("playpause").onclick = () => pace.toggle();
    vid.onclick = () => pace.toggle();
    $("rate").onchange = () => { rate = Number($("rate").value); saveRate(rate); vid.playbackRate = rate; };
    const track = $("track");
    const seek = (e) => { if (!vid.duration) return; const r = track.getBoundingClientRect(); vid.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * vid.duration; line(); };
    track.addEventListener("pointerdown", (e) => { seek(e); track.setPointerCapture(e.pointerId); const mv = (ev) => seek(ev); track.addEventListener("pointermove", mv); track.addEventListener("pointerup", () => track.removeEventListener("pointermove", mv), { once: true }); });
  } else pace = null;
}
function go(i) { if (i < 0 || i >= V.length) return; history.replaceState(null, "", "#" + (i + 1)); show(i); if ($("item").getBoundingClientRect().top < 0) $("item").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }
$("next").onclick = () => go(at + 1);
// The list: what needs a look first, each with its mark, then the rest by site, the fine ones quiet.
{
  let h = "", group = null;
  const mark = { failed: "✕", signin: "✕", changed: "△", fine: "✓" };
  V.forEach((v, i) => {
    const g = loud(v) ? "Needs a look" : v.group || "Everything else";
    if (g !== group) { if (group !== null) h += "</ol>"; group = g; h += "<p>" + esc(g) + "</p><ol>"; }
    h += '<li><button type="button" class="' + v.kind + '" data-i="' + i + '"><span class="k ' + v.kind + '" aria-label="' + esc(v.line.split(" ")[0]) + '">' + mark[v.kind] + "</span><span>" + esc(loud(v) ? v.title : v.short) + "</span></button></li>";
  });
  $("list").innerHTML = h + "</ol>";
}
const sheet = (open) => { document.body.classList.toggle("sheet", open); $("all").setAttribute("aria-expanded", String(open)); if (open) { const c = document.querySelector('#list button[aria-current="true"]'); if (c) c.focus(); } };
$("list").onclick = (e) => { const b = e.target.closest("button[data-i]"); if (!b) return; go(+b.dataset.i); sheet(false); };
$("all").onclick = () => sheet(!document.body.classList.contains("sheet"));
$("sheetbg").onclick = () => sheet(false);
// ↑ and ↓ move through the list while it has the focus.
$("list").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const all = [...document.querySelectorAll("#list button[data-i]")];
  const k = all.indexOf(document.activeElement);
  const n = all[Math.max(0, Math.min(all.length - 1, (k < 0 ? at : k) + (e.key === "ArrowDown" ? 1 : -1)))];
  n.focus(); go(+n.dataset.i);
});
addEventListener("keydown", (e) => { if (e.key === "Escape") sheet(false); });
// → is Next, except while typing somewhere.
addEventListener("keydown", (e) => { if (e.key !== "ArrowRight" || e.metaKey || e.ctrlKey || e.altKey) return; const t = e.target; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return; e.preventDefault(); go(at + 1); });
addEventListener("hashchange", () => show(fromHash()));
show(fromHash());
</script>
</body>
</html>
`;
}
