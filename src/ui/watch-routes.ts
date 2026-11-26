/**
 * Watch mode in the window.
 *
 * A test script (src/watch.ts) registers a session here, streams the live
 * picture in, and reports each step. The person watches /watch/<id>, picks
 * the pace, and flags what looks unclear. Their flags are written straight
 * into the session folder, so nothing depends on the script surviving, and
 * a finished session plays back from its video on the same screen.
 *
 *   GET  /watch                      the newest live session, or the list
 *   GET  /watch/<id>                 one session: live, or replay
 *   GET  /watch-files/<id>/<file>    its video and screenshots
 *   GET  /api/watch/where            where sessions go, and the chosen speed
 *   GET  /api/watch/sessions         every session, newest first
 *   POST /api/watch/sessions         a script starts one
 *   POST /api/watch/speed            Play or Pause: "watch" plays, "step" stops at the next step
 *   GET  /api/watch/<id>             its state
 *   GET  /api/watch/<id>/stream      SSE: its state, whenever it changes
 *   GET  /api/watch/<id>/live.mjpg   the live picture
 *   POST /api/watch/<id>/frame       a script's newest frame
 *   POST /api/watch/<id>/event       a script's step, result, end…
 *   GET  /api/watch/<id>/wait        a script waits for the person's pace
 *   POST /api/watch/<id>/next        the person presses Next
 *   POST /api/watch/<id>/hold        the person is writing a note
 *   POST /api/watch/<id>/flag        Unclear, or a note, at a moment
 *   POST /api/watch/<id>/note        the words for a flag
 *   POST /api/watch/<id>/fix         send the notes to be fixed (after 10 s)
 *   POST /api/watch/<id>/fix/undo    …unless taken back
 *   POST /api/watch/<id>/flag/remove a note taken back (Undo after "Tell your agent")
 *
 * Journeys (src/watch/journey-store.ts):
 *
 *   GET  /watch/j/<name>                      a changed or failed journey, at its moment
 *   GET  /watch/sessions                      every session, newest first
 *   GET  /watch-journey/<name>/<file>         the accepted run's pictures
 *   GET  /api/watch/journeys[?project=]       one project: its line, its journeys, its sites, the order Next walks
 *   GET  /api/watch/order?journey=|session=   where one sits in its project's order, and what comes next
 *   POST /api/watch/run                       { project }: run its journeys now ("Run all now")
 *   POST /api/watch/share                     { what, notes }: the page to send someone, and its local link
 *   GET  /api/watch/journeys/<name>           one journey: its last run and the moment
 *   POST /api/watch/journeys/<name>/accept    the last run is the new normal
 *
 * Adding an app (src/watch/suggest.ts) and the safety gate (src/watch/spaces.ts):
 *
 *   GET  /watch/add                           the address, then the proposals
 *   POST /api/watch/suggest                   { url }: look around it, propose journeys
 *   GET  /api/watch/suggest/<job>             where that stands
 *   POST /api/watch/suggest/<job>/continue    after the sign-in was saved, or { skip: true }
 *   POST /api/watch/suggest/<job>/add         { pick }: each runs once; only a pass is added
 *   POST /api/watch/spaces                    { url, test }: the person's answer, asked once
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ffmpegBin } from "../media-bin.js";
import {
  appendFlag, isSpeed, queueStatus, readFlagsIn, readMeta, readSteps, runFix, safeId, stepAt, unsent, updateFlag, writeFlagsIn,
  writeFixRequest, writeReport, type FlagRecord, type Speed,
} from "../watch/session.js";
import { acceptLast, baselineDir, journeyNameOk, journeyStates, listJourneys, momentOf, problemOf, readBaseline, readLast, readSnapshots, shortDate, summaryLine, whenWord, type RunRecord } from "../watch/journey-store.js";
import { describeChange } from "../watch/compare.js";
import { groupName } from "../watch/names.js";
import { listProjects, projectFolder, projectForSite, projectOfJourney } from "../watch/projects.js";
import { groupByApp, nightlyOnlyLine, outcomeWords, ranLine, readLastRun } from "../watch/deploys.js";
import { alreadyWatched, gate, journeyMeta, markSpace, originOf, spaceAnswer, spaceQuestion, withScheme } from "../watch/spaces.js";
import type { Added, Exploration, Suggestion } from "../watch/suggest.js";
import { hasLogin, siteOf } from "../logins.js";

/** Looking around an app and adding its journeys: minutes, so it runs on its
    own and the window asks where it stands. */
type SuggestJob = {
  id: string; url: string; origin: string; host: string;
  phase: "exploring" | "signin" | "ready" | "adding" | "done" | "error";
  /** What it is doing, in a line, while it works. */
  line: string;
  exploration: Exploration | null;
  suggestion: Suggestion | null;
  signInError: string | null;
  results: Added[] | null;
  error: string | null;
  at: number;
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIX_UNDO_MS = 10_000;
/** A script that has said nothing for this long has died without ending. */
const GONE_MS = 45_000;
const alive = (l: { ended: boolean; lastSeen: number } | undefined) => !!l && !l.ended && Date.now() - l.lastSeen < GONE_MS;

type Live = {
  id: string;
  dir: string;
  title: string;
  startedAt: number;
  frame: Buffer | null;
  url: string;
  scenario: string | null;
  next: number;
  hold: boolean;
  waiting: boolean;
  ended: boolean;
  fix: { repo: string; command: string } | null;
  mjpeg: Set<http.ServerResponse>;
  /** Re-sends the newest frame: Chrome shows a part only once the next one
      begins, so a screen that has gone still would sit one frame behind. */
  echo: NodeJS.Timeout | null;
  waiters: Set<() => void>;
  lastSeen: number;
};
type PendingFix = { timer: NodeJS.Timeout; sendAt: number; notes: number };

export type WatchDeps = {
  root: string;
  outRoot: () => string;
  token: string;
  /** Tell the activity feed: anybody watching it can pick the fix up. */
  activity: (type: string, data: unknown) => void;
  /** The window's port, so a run it starts shows up in it. */
  port?: number;
};

/** What the list shows of a journey that needs a look: a picture of the
    moment, when it says something (not for a missing sign-in), one plain
    line on what is wrong, and when. A failure for want of a sign-in names
    the site, so the list can put every journey that needs it on one card. */
function glance(last: RunRecord | null): { thumb: string | null; reason: string | null; when: string | null; signIn: string | null; site: string | null } {
  const none = { thumb: null, reason: null, when: null, signIn: null, site: null };
  if (!last?.dir || !fs.existsSync(last.dir)) return none;
  const when = whenWord(last.at);
  if (last.status !== "failed" && last.status !== "changed") return { ...none, when };
  const steps = readSteps(last.dir);
  const file = (rel: string | null | undefined) => rel && fs.existsSync(path.join(last.dir, rel)) ? `/watch-files/${last.session}/${rel}` : null;
  const lower = (t: string) => t.replace(/^\p{Lu}(?!\p{Lu})/u, (c) => c.toLowerCase());
  if (last.status === "failed") {
    const f = steps.find((s) => s.result === "fail");
    const p = problemOf((f?.note || last.error || "").trim());
    if (p.signIn) return { thumb: null, reason: p.broke, when, signIn: p.signIn, site: new URL(p.signIn).host };
    return { thumb: file(f?.screenshot), reason: f ? `“${f.intent}” failed${p.broke ? `: ${lower(p.broke)}` : "."}` : p.broke || "It did not finish.", when, signIn: null, site: null };
  }
  const c = last.changes[0];
  if (!c) return { ...none, when };
  return { thumb: file(c.after) ?? file(steps.find((s) => s.n === c.n)?.screenshot), reason: `“${c.intent}”: ${lower(describeChange(c))}.`, when, signIn: null, site: null };
}

export function watchRoutes(deps: WatchDeps) {
  const live = new Map<string, Live>();
  const watchers = new Map<string, Set<(state: unknown) => void>>();
  const fixes = new Map<string, PendingFix>();
  const lastFix = new Map<string, { name: string; notes: number; at: number }>();
  const locks = new Map<string, Promise<unknown>>();
  const jobs = new Map<string, SuggestJob>();
  let running: import("node:child_process").ChildProcess | null = null;

  /** The journey a session is the last run of, if any. */
  const journeyOfSession = (session: string) => journeyStates(deps.root).find((j) => j.session === session)?.name ?? null;
  const projectOfSession = (session: string) => { const j = journeyOfSession(session); return j ? projectOfJourney(listProjects(deps.root), j)?.id ?? null : null; };

  /** One project as the list shows it: its line, its journeys, its sites, and the order Next walks.
      With no project asked for, the first that needs a look, else the first. */
  function projectView(asked: string | null) {
    const projects = listProjects(deps.root);
    const all = journeyStates(deps.root);
    const files = new Map(listJourneys(deps.root).map((j) => [j.name, j.file]));
    const loud = (names: string[]) => all.filter((j) => names.includes(j.name) && (j.status === "failed" || j.status === "changed")).length;
    const chosen = projects.find((x) => x.id === asked) ?? projects.find((x) => loud(x.journeys)) ?? projects[0] ?? null;
    const mine = all.filter((j) => chosen?.journeys.includes(j.name));
    // Data-changing journeys for an app nobody has been asked about: the one question, once.
    let ask: { url: string; question: string } | null = null;
    const rows = mine.map((j) => {
      const file = files.get(j.name)!;
      const g = gate(deps.root, { name: j.name, file });
      if (!g.run && g.origin && spaceAnswer(deps.root, g.origin) === null && !ask) ask = { url: g.origin, question: spaceQuestion(g.origin) };
      let title = j.title;
      if (title === j.name) { try { title = journeyMeta(fs.readFileSync(file, "utf8")).title ?? j.title; } catch { /* the name */ } }
      const look = glance(j.last);
      return g.run ? { name: j.name, title, line: j.line, status: j.status, session: j.session, ...look }
        : { name: j.name, title, line: "Skipped — not a test space", status: "skipped" as const, session: j.session, why: g.why, when: look.when, thumb: null, reason: null, signIn: null, site: null };
    });
    // Sites, named in words ("Shop", "Sign-in screens"), each journey by the rest of its title; the address is for a hover.
    const groups = groupByApp(deps.root, rows).map((g) => {
      // Named from the journeys the list shows under it (those needing a look are on cards above).
      const quiet = g.items.filter((r) => r.status !== "failed" && r.status !== "changed");
      const n = groupName((quiet.length ? quiet : g.items).map((r) => r.title), g.host);
      return { host: g.host, name: n.name, names: g.items.map((r) => r.name), short: Object.fromEntries(g.items.map((r) => [r.name, n.short(r.title)])) };
    });
    // The order the list shows and Next walks: what needs a look (failures, those sharing a
    // missing sign-in together, then changes), then the rest, site by site.
    const order: { name: string; href: string; loud: boolean }[] = [];
    const put = (r: (typeof rows)[number], isLoud: boolean) => { if (!order.some((o) => o.name === r.name)) order.push({ name: r.name, href: isLoud ? `/watch/j/${r.name}` : r.session ? `/watch/${r.session}` : `/watch/j/${r.name}`, loud: isLoud }); };
    const failed = rows.filter((r) => r.status === "failed");
    for (const r of failed) { put(r, true); if (r.signIn) for (const o of failed) if (o.signIn && o.site === r.site) put(o, true); }
    for (const r of rows.filter((x) => x.status === "changed")) put(r, true);
    const byName = new Map(rows.map((r) => [r.name, r]));
    for (const g of groups) for (const n of g.names) { const r = byName.get(n)!; if (r.status !== "failed" && r.status !== "changed") put(r, false); }
    return {
      project: chosen?.id ?? null,
      projects: projects.map((x) => ({ id: x.id, name: x.name, loud: loud(x.journeys) })),
      summary: summaryLine(mine.map((j) => j.last)),
      // What started the last run, and when (for agents and the CLI; the list itself says only the one line).
      ran: (() => { const lr = readLastRun(deps.root); const sm = summaryLine(mine.map((j) => j.last)); return lr ? `${ranLine(lr)}${sm ? "" : ` — ${outcomeWords({ journeys: lr.journeys, changed: 0, failed: 0 })}`}.` : null; })(),
      blind: nightlyOnlyLine(deps.root),
      ask,
      journeys: rows,
      groups,
      order,
    };
  }
  const watchRoot = () => path.join(deps.outRoot(), "watch");
  const speedFile = path.join(deps.root, ".drafts", "watch-speed");
  let speed: Speed = (() => { try { const s = fs.readFileSync(speedFile, "utf8").trim(); return isSpeed(s) ? s : "watch"; } catch { return "watch"; } })();

  const page = () => fs.readFileSync(path.join(HERE, "watch.html"), "utf8")
    .replace("</head>", `<script>window.__retakeToken=${JSON.stringify(deps.token)}</script></head>`);

  const dirFor = (id: string): string | null => {
    if (!safeId(id)) return null;
    const l = live.get(id);
    if (l) return l.dir;
    const d = path.join(watchRoot(), id);
    return fs.existsSync(path.join(d, "session.json")) ? d : null;
  };

  /** One write at a time per session: a flag's number and its picture's
      name must agree even when two land together. */
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(id, run.catch(() => {}));
    return run;
  };

  /** Look around the app, then propose. A sign-in with no test account saved
      stops it there first: that question comes before any waiting, and the
      look after it (signed in) is the one worth proposing from. */
  async function look(job: SuggestJob, again: boolean) {
    try {
      const { explore } = await import("../watch/suggest.js");
      const x = await explore(job.url, { log: (l) => { job.line = l; } });
      job.exploration = x;
      job.signInError = x.signInError ?? null;
      if (x.signIn && !hasLogin(siteOf(job.origin)) && !again) { job.phase = "signin"; return; }
      await propose(job, x);
    } catch (e) { job.phase = "error"; job.error = (e as Error).message.split("\n")[0]; }
  }
  async function propose(job: SuggestJob, x: Exploration) {
    try {
      const { proposeJourneys, keepSuggestion } = await import("../watch/suggest.js");
      const { proposals, by } = await proposeJourneys(x, { log: (l) => { job.line = l; } });
      job.suggestion = { origin: x.origin, at: new Date().toISOString(), by, signIn: x.signIn, signedIn: x.signedIn, proposals };
      keepSuggestion(deps.root, job.suggestion);
      job.phase = "ready";
    } catch (e) { job.phase = "error"; job.error = (e as Error).message.split("\n")[0]; }
  }
  const jobView = (j: SuggestJob) => ({
    id: j.id, origin: j.origin, host: j.host, phase: j.phase, line: j.line, error: j.error, signInError: j.signInError,
    signIn: j.exploration?.signIn ?? null, signedIn: j.exploration?.signedIn ?? false, by: j.suggestion?.by ?? null,
    proposals: j.suggestion?.proposals.map((p) => {
      const signsIn = p.steps.some((x) => x.do === "signIn");
      const watched = alreadyWatched(deps.root, j.origin, p);
      // Behind a sign-in nobody gave a test account for: it cannot pass its first run.
      const noAccount = signsIn && !!j.exploration?.signIn && !j.exploration.signedIn && !hasLogin(siteOf(j.origin));
      // Ticked to start with: reads only, not watched already, and able to run.
      return { title: p.title, checks: p.checks, changes: p.changes, signsIn, watched, noAccount, ticked: p.changes === "reads" && !watched && !noAccount };
    }) ?? [],
    testSpace: spaceAnswer(deps.root, j.origin), question: spaceQuestion(j.origin),
    results: j.results,
    // The project its journeys go in: decided when the site is already watched, else asked.
    ...(() => { const w = projectForSite(deps.root, j.origin); return { projectDecided: w.existing ? { id: w.existing.id, name: w.existing.name } : null, newProject: w.fresh, projects: listProjects(deps.root).map((x) => ({ id: x.id, name: x.name })) }; })(),
  });

  function state(id: string) {
    const dir = dirFor(id);
    if (!dir) return null;
    const meta = readMeta(dir);
    const l = live.get(id);
    const steps = readSteps(dir);
    const statuses = queueStatus(path.dirname(dir));
    const flags = readFlagsIn(dir).map((f) => ({ ...f, fixStatus: f.fix ? statuses.get(`${dir}#${f.fix}`) ?? "sent" : null }));
    const pf = fixes.get(id);
    const isLive = alive(l) && !meta?.endedAt;
    return {
      id, dir, title: meta?.title ?? l?.title ?? id, startedAt: meta?.startedAt ?? null, endedAt: meta?.endedAt ?? null,
      video: meta?.video ?? null, problem: meta?.problem ?? null,
      live: isLive, speed, waiting: !!l?.waiting, hold: !!l?.hold, next: l?.next ?? 0,
      scenario: l?.scenario ?? null, url: l?.url ?? "",
      steps, flags,
      fix: { pending: pf ? { sendAt: pf.sendAt, notes: pf.notes } : null, last: lastFix.get(id) ?? null },
      now: Date.now(),
    };
  }

  const push = (id: string) => {
    const set = watchers.get(id);
    if (!set?.size) return;
    const s = state(id);
    for (const w of set) w(s);
  };
  const wake = (l: Live) => { for (const w of [...l.waiters]) w(); };
  const control = (l?: Live) => ({ speed, next: l?.next ?? 0, hold: !!l?.hold });

  function list() {
    let ids: string[] = [];
    try { ids = fs.readdirSync(watchRoot()).filter((x) => safeId(x)); } catch { /* none yet */ }
    for (const id of live.keys()) if (!ids.includes(id)) ids.push(id);
    return ids.map((id) => {
      const dir = dirFor(id);
      const meta = dir ? readMeta(dir) : null;
      if (!dir || !meta) return null;
      const steps = readSteps(dir), flags = readFlagsIn(dir);
      const l = live.get(id);
      return {
        id, title: meta.title, startedAt: meta.startedAt, endedAt: meta.endedAt, video: meta.video,
        live: alive(l) && !meta.endedAt,
        steps: steps.length, passed: steps.filter((s) => s.result === "pass").length, failed: steps.filter((s) => s.result === "fail").length, flags: flags.length,
      };
    }).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Send a session's unsent notes after the undo window. */
  function scheduleFix(id: string): PendingFix | null {
    const dir = dirFor(id);
    if (!dir) return null;
    const todo = unsent(readFlagsIn(dir));
    if (!todo.length) return null;
    const had = fixes.get(id);
    if (had) clearTimeout(had.timer);
    const pf: PendingFix = {
      sendAt: Date.now() + FIX_UNDO_MS, notes: todo.length,
      timer: setTimeout(() => {
        fixes.delete(id);
        void serial(id, async () => {
          const sent = writeFixRequest(dir);
          if (sent) {
            writeReport(dir);
            lastFix.set(id, { name: sent.name, notes: sent.notes, at: Date.now() });
            deps.activity("fix-request", { dir, request: sent.name, notes: sent.notes, brief: sent.md, json: sent.json });
            const fix = live.get(id)?.fix;
            if (fix) runFix(fix, sent.md);
          }
          push(id);
        });
      }, FIX_UNDO_MS),
    };
    fixes.set(id, pf);
    push(id);
    return pf;
  }

  /** A picture of the moment: the live frame, or the video at that time. */
  async function shotFor(id: string, dir: string, n: number, source: "live" | "replay", time: number): Promise<string | null> {
    const rel = `shots/flag-${String(n).padStart(2, "0")}.jpg`;
    const out = path.join(dir, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const l = live.get(id);
    if (source === "live" && l?.frame) { fs.writeFileSync(out, l.frame); return rel; }
    const video = path.join(dir, "session.mp4");
    if (!fs.existsSync(video)) return null;
    const grab = (seek: string[]) => new Promise<boolean>((done) => {
      fs.rmSync(out, { force: true });
      execFile(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...seek, "-i", video, "-frames:v", "1", "-q:v", "3", out], (e) => done(!e && fs.existsSync(out)));
    });
    // A moment at the very end of the video has no frame after it to seek
    // to: the last frame is the picture of it.
    if (await grab(["-ss", Math.max(0, time).toFixed(2)])) return rel;
    return (await grab(["-sseof", "-0.3"])) ? rel : null;
  }

  function sendFile(f: string, req: http.IncomingMessage, res: http.ServerResponse) {
    const stat = fs.statSync(f);
    const type = f.endsWith(".mp4") ? "video/mp4" : f.endsWith(".jpg") ? "image/jpeg" : f.endsWith(".png") ? "image/png" : f.endsWith(".md") ? "text/markdown; charset=utf-8" : f.endsWith(".json") ? "application/json" : "application/octet-stream";
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const pipe = (s: fs.ReadStream) => { s.on("error", () => { if (!res.headersSent) res.writeHead(500); res.end(); }); s.pipe(res); };
    if (range) {
      const start = Number(range[1] || 0);
      const end = Math.min(range[2] ? Number(range[2]) : stat.size - 1, stat.size - 1);
      if (start > end || start >= stat.size) { res.writeHead(416, { "content-range": `bytes */${stat.size}` }); return res.end(); }
      res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${stat.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      return pipe(fs.createReadStream(f, { start, end }));
    }
    res.writeHead(200, { "content-type": type, "content-length": stat.size, "accept-ranges": "bytes", "cache-control": "no-store" });
    pipe(fs.createReadStream(f));
  }

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    if (res.headersSent) { res.end(); return true; }
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return true;
  };

  /** Pages and files: no token, like the window's own page. */
  function handlePage(req: http.IncomingMessage, res: http.ServerResponse, p: string): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    if (p === "/watch" || p === "/watch/" || /^\/watch\/[a-z0-9-]+$/.test(p) || /^\/watch\/j\/[a-z0-9-]+$/.test(p)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page());
      return true;
    }
    const mj = /^\/watch-journey\/([a-z0-9-]+)\/(snapshots\/[A-Za-z0-9._-]+)$/.exec(p);
    if (mj) {
      const f = journeyNameOk(mj[1]) ? path.join(baselineDir(deps.root, mj[1]), mj[2]) : "";
      if (!f || !fs.existsSync(f)) return json(res, 404, { error: "not found" });
      sendFile(f, req, res);
      return true;
    }
    const mf = /^\/watch-files\/([a-z0-9-]+)\/((?:shots\/|snapshots\/)?[A-Za-z0-9._-]+)$/.exec(p);
    if (mf) {
      const dir = dirFor(mf[1]);
      const f = dir ? path.join(dir, mf[2]) : "";
      if (!f || mf[2].startsWith(".") || !fs.existsSync(f)) return json(res, 404, { error: "not found" });
      sendFile(f, req, res);
      return true;
    }
    return false;
  }

  /** /api/watch/…, after the window's guard has passed it. */
  async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string, readBody: () => Promise<string>): Promise<boolean> {
    if (!p.startsWith("/api/watch")) return false;
    const body = async <T>() => { const t = await readBody(); return (t ? JSON.parse(t) : {}) as T; };

    if (p === "/api/watch/where" && req.method === "GET") return json(res, 200, { out: deps.outRoot(), speed });
    if (p === "/api/watch/sessions" && req.method === "GET") return json(res, 200, list());

    // ---- journeys ----
    if (p === "/api/watch/journeys" && req.method === "GET") {
      const v = projectView(url.searchParams.get("project"));
      const live = list().find((x) => x.live);
      const liveProject = live ? projectOfSession(live.id) : null;
      return json(res, 200, {
        ...v,
        sessions: list().length,
        // A run going now is a line in the header, in whichever project it is.
        live: live?.id ?? null, liveTitle: live?.title ?? null, liveProject,
      });
    }
    // Where a journey (or the session of one) sits in its project's order, and what comes next.
    if (p === "/api/watch/order" && req.method === "GET") {
      const journey = url.searchParams.get("journey") ?? (url.searchParams.get("session") ? journeyOfSession(url.searchParams.get("session")!) : null);
      if (!journey) return json(res, 200, { at: null });
      const pr = projectOfJourney(listProjects(deps.root), journey);
      const v = projectView(pr?.id ?? null);
      const i = v.order.findIndex((o) => o.name === journey);
      if (i < 0) return json(res, 200, { at: null });
      const next = v.order[i + 1] ?? null;
      return json(res, 200, { at: i + 1, total: v.order.length, next: next?.href ?? null, lastLoud: v.order[i].loud && !!next && !next.loud, project: v.project });
    }
    // Look again, now: every journey of a project (or all), in a run of their own.
    if (p === "/api/watch/run" && req.method === "POST") {
      const b = await body<{ project?: string }>();
      if (running && running.exitCode === null) return json(res, 409, { error: "A run is already going." });
      const which = b.project && /^[a-z0-9][a-z0-9-]*$/.test(b.project) ? b.project : "all";
      running = spawn(process.execPath, [...process.execArgv, process.argv[1], "watch", "run", which], { cwd: deps.root, env: { ...process.env, RETAKE_UI: `http://localhost:${deps.port ?? 4310}` }, stdio: "ignore" });
      running.on("error", () => { running = null; });
      return json(res, 200, { started: which });
    }
    const mjr = /^\/api\/watch\/journeys\/([a-z0-9-]+)(\/accept)?$/.exec(p);
    if (mjr) {
      const name = mjr[1];
      if (!listJourneys(deps.root).some((j) => j.name === name)) return json(res, 404, { error: "no such journey" });
      if (mjr[2] && req.method === "POST") {
        try { acceptLast(deps.root, name); } catch (e) { return json(res, 409, { error: (e as Error).message }); }
        deps.activity("journey-accepted", { name });
        const next = journeyStates(deps.root).find((j) => j.status === "changed")?.name ?? null;
        return json(res, 200, { ok: true, next });
      }
      if (mjr[2] || req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      const last = readLast(deps.root, name);
      const baseline = readBaseline(deps.root, name);
      const st = journeyStates(deps.root).find((j) => j.name === name)!;
      const session = last?.dir && fs.existsSync(last.dir) ? last.session : null;
      const moment = last && session ? momentOf(last, baseline, readSnapshots(last.dir), readSteps(last.dir)) : null;
      const meta = session && last ? readMeta(last.dir) : null;
      const steps = session && last ? readSteps(last.dir) : [];
      const at = moment ? steps.find((x) => x.n === moment.n) : undefined;
      // A failure in words a person can act on: what broke, and what to do.
      const problem = last?.status === "failed" ? problemOf((moment?.note || last.error || "").trim()) : null;
      return json(res, 200, {
        name, title: st.title, line: st.line, status: last?.status ?? null, at: last?.at ?? null, error: last?.error ?? null,
        when: last ? whenWord(last.at) : null, steps: steps.length, expect: at?.expect ?? null, problem,
        // Where on the session's clock the moment shows its result: a note sent from here lands on that step.
        stepAt: at ? Math.max(0, (at.tEnd ?? at.t) - 100) / 1000 : null,
        session, video: meta?.video ?? null, changes: last?.changes.length ?? 0,
        others: last ? last.changes.slice(1).map((c) => ({ n: c.n, intent: c.intent })) : [],
        acceptedAt: baseline?.acceptedAt ?? null, accepted: baseline ? shortDate(baseline.acceptedAt) : null, moment,
      });
    }
    // ---- a page to send someone ----
    if (p === "/api/watch/share" && req.method === "POST") {
      const b = await body<{ what?: string; notes?: boolean }>();
      const what = String(b.what ?? "all");
      try {
        const { buildWatchShare } = await import("../watch/share.js");
        const { ensureShareServer, shareRoot, shareUrl } = await import("../share.js");
        const s = buildWatchShare({ root: deps.root, outRoot: deps.outRoot(), what, notes: b.notes === true });
        const port = await ensureShareServer(shareRoot(deps.outRoot()));
        return json(res, 200, { url: shareUrl(s.name, port), title: s.title, runs: s.items.length, notes: b.notes === true });
      } catch (e) { return json(res, 400, { error: (e as Error).message }); }
    }
    // ---- adding an app ----
    if (p === "/api/watch/spaces" && req.method === "POST") {
      const b = await body<{ url?: string; test?: boolean }>();
      if (!b.url || !originOf(b.url) || typeof b.test !== "boolean") return json(res, 400, { error: "an app's address, and yes or no" });
      return json(res, 200, { origin: markSpace(deps.root, b.url, b.test), test: b.test });
    }
    if (p === "/api/watch/suggest" && req.method === "POST") {
      const b = await body<{ url?: string }>();
      const raw = String(b.url ?? "").trim();
      const url = withScheme(raw);
      const origin = originOf(url);
      if (!origin) return json(res, 400, { error: "That is not an app's address — something like app.example.com." });
      const going = [...jobs.values()].find((j) => j.origin === origin && (j.phase === "exploring" || j.phase === "adding"));
      if (going) return json(res, 200, jobView(going));
      const job: SuggestJob = { id: "s" + Date.now().toString(36), url, origin, host: new URL(origin).host, phase: "exploring", line: "", exploration: null, suggestion: null, signInError: null, results: null, error: null, at: Date.now() };
      jobs.set(job.id, job);
      for (const [k, j] of jobs) if (Date.now() - j.at > 6 * 3600_000) jobs.delete(k);
      void look(job, false);
      return json(res, 200, jobView(job));
    }
    const ms = /^\/api\/watch\/suggest\/(s[a-z0-9]+)(?:\/(continue|add))?$/.exec(p);
    if (ms) {
      const job = jobs.get(ms[1]);
      if (!job) return json(res, 404, { error: "That look is over — give the address again." });
      if (!ms[2] && req.method === "GET") return json(res, 200, jobView(job));
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (ms[2] === "continue") {
        const b = await body<{ skip?: boolean }>();
        if (b.skip && job.exploration) { job.phase = "exploring"; void propose(job, job.exploration); return json(res, 200, jobView(job)); }
        job.phase = "exploring";
        void look(job, true);
        return json(res, 200, jobView(job));
      }
      const b = await body<{ pick?: number[]; project?: string }>();
      const pick = (b.pick ?? []).filter((n) => Number.isInteger(n) && n >= 1 && n <= (job.suggestion?.proposals.length ?? 0));
      if (!job.suggestion || !pick.length) return json(res, 400, { error: "Tick at least one." });
      // Which project: the one already watching this site, else the person's pick, else a new one for it.
      const w = projectForSite(deps.root, job.origin);
      const picked = w.existing ?? listProjects(deps.root).find((x) => x.id === b.project) ?? null;
      const folder = projectFolder(deps.root, picked ?? w.fresh, !picked);
      job.phase = "adding"; job.line = "";
      void (async () => {
        try {
          const { addJourneys } = await import("../watch/suggest.js");
          job.results = await addJourneys({ root: deps.root, out: deps.outRoot(), suggestion: job.suggestion!, pick, folder, log: (l) => { job.line = l.replace(/^[▶✓✗]\s*/, ""); } });
          job.phase = "done";
          deps.activity("journeys-added", { origin: job.origin, added: job.results.filter((r) => r.added).map((r) => r.name) });
        } catch (e) { job.phase = "error"; job.error = (e as Error).message.split("\n")[0]; }
      })();
      return json(res, 200, jobView(job));
    }

    if (p === "/api/watch/speed" && req.method === "POST") {
      const b = await body<{ speed?: string }>();
      if (!isSpeed(b.speed)) return json(res, 400, { error: "speed is watch (Play) or step (Pause)" });
      speed = b.speed;
      try { fs.mkdirSync(path.dirname(speedFile), { recursive: true }); fs.writeFileSync(speedFile, speed); } catch { /* kept in memory */ }
      for (const l of live.values()) { wake(l); push(l.id); }
      return json(res, 200, { speed });
    }
    if (p === "/api/watch/sessions" && req.method === "POST") {
      const b = await body<{ id?: string; dir?: string; title?: string; startedAt?: string; fix?: { repo?: string; command?: string } | null }>();
      if (!b.id || !safeId(b.id) || !b.dir || path.basename(b.dir) !== b.id || !fs.existsSync(path.join(b.dir, "session.json"))) return json(res, 400, { error: "a session needs its id and the folder it writes to" });
      const had = live.get(b.id);
      const l: Live = had ?? {
        id: b.id, dir: path.resolve(b.dir), title: String(b.title ?? b.id), startedAt: Date.parse(b.startedAt ?? "") || Date.now(),
        frame: null, url: "", scenario: null, next: 0, hold: false, waiting: false, ended: false,
        fix: b.fix?.repo && b.fix?.command ? { repo: b.fix.repo, command: b.fix.command } : null,
        mjpeg: new Set(), echo: null, waiters: new Set(), lastSeen: Date.now(),
      };
      live.set(b.id, l);
      deps.activity("watch", { id: l.id, title: l.title, link: `/watch/${l.id}` });
      push(l.id);
      return json(res, 200, { ok: true, ...control(l) });
    }

    const m = /^\/api\/watch\/([a-z0-9-]+)(?:\/(stream|live\.mjpg|frame|event|wait|next|hold|flag|flag\/remove|note|fix|fix\/undo))?$/.exec(p);
    if (!m) return json(res, 404, { error: "not found" });
    const id = m[1], sub = m[2] ?? "";
    const dir = dirFor(id);
    if (!dir) return json(res, 404, { error: "no such session" });
    const l = live.get(id);
    if (l) l.lastSeen = Date.now();

    if (!sub && req.method === "GET") return json(res, 200, state(id));

    if (sub === "stream" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (s: unknown) => res.write(`event: state\ndata: ${JSON.stringify(s)}\n\n`);
      send(state(id));
      const set = watchers.get(id) ?? new Set();
      watchers.set(id, set);
      set.add(send);
      const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => { set.delete(send); clearInterval(beat); });
      return true;
    }

    if (sub === "live.mjpg" && req.method === "GET") {
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame", "cache-control": "no-store", connection: "keep-alive" });
      // Each part is closed by the next boundary at once, so the browser
      // shows a frame the moment it arrives rather than when the next comes.
      res.write("--frame\r\n");
      if (l?.frame) { writePart(res, l.frame); writePart(res, l.frame); }
      if (!l) return true;
      l.mjpeg.add(res);
      req.on("close", () => l.mjpeg.delete(res));
      return true;
    }

    if (sub === "frame" && req.method === "POST") {
      const b = await body<{ data?: string; url?: string }>();
      if (!l) return json(res, 409, { error: "not live" });
      if (b.data) {
        l.frame = Buffer.from(b.data, "base64");
        const frame = l.frame;
        for (const r of l.mjpeg) if (r.writableLength < 4_000_000) writePart(r, frame);
        if (l.echo) clearTimeout(l.echo);
        l.echo = setTimeout(() => { l.echo = null; if (l.frame === frame) for (const r of l.mjpeg) writePart(r, frame); }, 150);
      }
      if (b.url) l.url = b.url;
      return json(res, 200, control(l));
    }

    if (sub === "event" && req.method === "POST") {
      const b = await body<{ kind?: string; url?: string; scenario?: string | null }>();
      if (!l) return json(res, 409, { error: "not live" });
      if (b.url) l.url = b.url;
      if (b.kind === "scenario") l.scenario = b.scenario ?? null;
      if (b.kind === "end") {
        l.ended = true; l.waiting = false; l.hold = false;
        for (const r of l.mjpeg) r.end();
        l.mjpeg.clear();
        wake(l);
        scheduleFix(id);
      }
      push(id);
      return json(res, 200, control(l));
    }

    if (sub === "wait" && req.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const ms = Math.min(Math.max(Number(url.searchParams.get("ms") ?? 1500), 0), 30_000);
      if (!l || l.ended || l.next > after) return json(res, 200, control(l));
      const was = { speed, hold: l.hold };
      await new Promise<void>((done) => {
        const finish = () => { clearTimeout(t); l.waiters.delete(check); req.off("close", finish); done(); };
        const check = () => { if (l.next > after || speed !== was.speed || l.hold !== was.hold || l.ended) finish(); };
        const t = setTimeout(finish, ms);
        l.waiters.add(check);
        req.on("close", finish);
        l.waiting = true;
        push(id);
      });
      if (!l.waiters.size) l.waiting = false;
      push(id);
      return json(res, 200, control(l));
    }

    if (sub === "next" && req.method === "POST") {
      if (!l || l.ended) return json(res, 409, { error: "not live" });
      l.next++;
      wake(l);
      push(id);
      return json(res, 200, control(l));
    }

    if (sub === "hold" && req.method === "POST") {
      const b = await body<{ on?: boolean }>();
      if (l && !l.ended) { l.hold = !!b.on; wake(l); push(id); }
      return json(res, 200, control(l));
    }

    if (sub === "flag" && req.method === "POST") {
      const b = await body<{ kind?: string; note?: string; time?: number }>();
      const kind: FlagRecord["kind"] = b.kind === "note" ? "note" : "unclear";
      const isLive = !!l && !l.ended;
      const source: FlagRecord["source"] = isLive ? "live" : "replay";
      const meta = readMeta(dir);
      const startMs = l?.startedAt ?? Date.parse(meta?.startedAt ?? "");
      const time = isLive ? (Date.now() - startMs) / 1000 : Math.max(0, Number(b.time ?? 0));
      const flag = await serial(id, async () => {
        const n = (readFlagsIn(dir).at(-1)?.n ?? 0) + 1;
        const steps = readSteps(dir);
        const step = stepAt(steps, time * 1000);
        const shot = await shotFor(id, dir, n, source, time);
        const url0 = isLive ? l!.url : steps.find((s) => s.n === step)?.url ?? "";
        const f = appendFlag(dir, { kind, step, time: Math.round(time * 100) / 100, at: new Date().toISOString(), note: String(b.note ?? "").slice(0, 500), screenshot: shot, url: url0, source });
        if (meta?.endedAt) writeReport(dir);
        return f;
      });
      // Already counting down to send? Then this one goes too, and the person gets their ten seconds again.
      if (fixes.has(id)) scheduleFix(id);
      push(id);
      return json(res, 200, { flag });
    }

    if (sub === "note" && req.method === "POST") {
      const b = await body<{ n?: number; note?: string }>();
      const f = await serial(id, async () => {
        const r = updateFlag(dir, Number(b.n), { note: String(b.note ?? "").slice(0, 500) });
        if (r && readMeta(dir)?.endedAt) writeReport(dir);
        return r;
      });
      push(id);
      return f ? json(res, 200, { flag: f }) : json(res, 404, { error: "no such flag" });
    }

    if (sub === "fix" && req.method === "POST") {
      if (l && !l.ended) return json(res, 409, { error: "the session is still running" });
      const pf = fixes.get(id) ?? scheduleFix(id);
      return json(res, 200, { pending: pf ? { sendAt: pf.sendAt, notes: pf.notes } : null });
    }
    // Taking a note back: the window's Undo after "Tell your agent" undoes all of it.
    // A note already sent to be fixed stays: that request has gone.
    if (sub === "flag/remove" && req.method === "POST") {
      const b = await body<{ n?: number }>();
      const n = Number(b.n);
      const removed = await serial(id, async () => {
        const flags = readFlagsIn(dir);
        const f = flags.find((x) => x.n === n);
        if (!f || f.fix) return false;
        writeFlagsIn(dir, flags.filter((x) => x !== f));
        if (f.screenshot && /^shots\/flag-\d+\.jpg$/.test(f.screenshot)) fs.rmSync(path.join(dir, f.screenshot), { force: true });
        if (readMeta(dir)?.endedAt) writeReport(dir);
        return true;
      });
      push(id);
      return json(res, removed ? 200 : 409, removed ? { removed: n } : { error: "no such note, or it has already gone to be fixed" });
    }
    if (sub === "fix/undo" && req.method === "POST") {
      const pf = fixes.get(id);
      if (pf) { clearTimeout(pf.timer); fixes.delete(id); }
      push(id);
      return json(res, 200, { undone: !!pf });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  return { handlePage, handleApi };
}

function writePart(res: http.ServerResponse, jpeg: Buffer) {
  res.write(`Content-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  res.write("\r\n--frame\r\n");
}
