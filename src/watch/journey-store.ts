/**
 * Journeys on disk: where they are, what their last run found, and the run
 * a person accepted as normal.
 *
 *   watch/<name>.mjs                      the journey: `export default async (page, w, kit) => {…}`
 *   watch/_<anything>.mjs                 shared code the journeys import, never run itself
 *   watch/.journeys/<name>/baseline/      the accepted run: snapshots.json and its pictures
 *   watch/.journeys/<name>/last.json      what the newest run found
 *   watch/.journeys/<name>/runs.jsonl     every run, one line each
 *   outputs/watch/<session>/              the run itself, as any Watch session, plus
 *                                         snapshots.json, snapshots/ and journey.json
 *
 * The accepted run sits with the journeys, not in outputs/: it is a decision a
 * person made, and outputs/ is where things that can be made again live.
 *
 * Nothing here launches a browser: the window reads and accepts with this
 * alone (the runner is src/watch/journeys.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { decodePng, describeChange, keyOf, matchSteps, type JourneyStatus, type Snapshot, type StepChange } from "./compare.js";
import { readFlagsIn, readJson, writeJson } from "./session.js";

export const JOURNEY_EXT = /\.(mjs|js)$/;
/** A journey's name is its file's: lower case, digits and dashes. */
export const journeyNameOk = (s: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);

export const journeysDir = (root: string) => path.join(root, "watch");
const stateDir = (root: string, name: string) => path.join(journeysDir(root), ".journeys", name);
export const baselineDir = (root: string, name: string) => path.join(stateDir(root, name), "baseline");

/** The journeys in a workspace, by name: watch/<name>.mjs, and
    watch/<project>/<name>.mjs for a project kept in its own folder. Files
    and folders starting with `_` or `.` are helpers, not journeys. A name is
    one journey across the workspace; a second file of the same name is
    left out. */
export function listJourneys(root: string): { name: string; file: string; folder?: string }[] {
  const out: { name: string; file: string; folder?: string }[] = [];
  const seen = new Set<string>();
  const take = (dir: string, folder?: string) => {
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const f of files.sort()) {
      if (!JOURNEY_EXT.test(f) || /^[_.]/.test(f)) continue;
      const name = f.replace(JOURNEY_EXT, "");
      if (!journeyNameOk(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, file: path.join(dir, f), ...(folder ? { folder } : {}) });
    }
  };
  take(journeysDir(root));
  let dirs: fs.Dirent[] = [];
  try { dirs = fs.readdirSync(journeysDir(root), { withFileTypes: true }); } catch { /* no watch/ yet */ }
  for (const d of dirs.filter((x) => x.isDirectory() && !/^[_.]/.test(x.name) && journeyNameOk(x.name)).sort((a, b) => a.name.localeCompare(b.name))) take(path.join(journeysDir(root), d.name), d.name);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `all`, a project, or one journey by name. A name that is not there says which are. */
export function pickJourneys<J extends { name: string; file: string; folder?: string }>(all: J[], which: string, projectOf?: (j: J) => string): J[] {
  const w = which.trim().replace(JOURNEY_EXT, "").replace(/^watch\//, "");
  if (w === "all") {
    if (!all.length) throw new Error("no journeys yet — a journey is a script at watch/<name>.mjs in this workspace");
    return all;
  }
  const one = all.find((j) => j.name === w);
  if (one) return [one];
  const project = all.filter((j) => j.folder === w || (projectOf && projectOf(j) === w));
  if (project.length) return project;
  throw new Error(`no journey or project called "${w}"${all.length ? ` — there are: ${all.map((j) => j.name).join(", ")}` : " — a journey is a script at watch/<name>.mjs in this workspace"}`);
}

// ---------- runs ----------

export type RunRecord = {
  journey: string;
  title: string;
  at: string;
  /** The session this run is, and its folder. */
  session: string;
  dir: string;
  status: JourneyStatus;
  scheduled: boolean;
  /** Why the journey stopped, when it did not reach its end. Secrets scrubbed. */
  error: string | null;
  steps: number;
  changes: StepChange[];
  /** This run had nothing to compare with, so it became the normal (only its
      passing steps, when one failed). */
  firstRun?: boolean;
  /** Steps that got their normal on this run, at their first pass. */
  adopted?: number;
  /** Set when a person accepted this run as normal. */
  acceptedAt?: string;
};

export type Baseline = {
  acceptedAt: string; from: string; steps: Snapshot[];
  /** Steps that did not pass when this normal was made, by what they say they
      do. Each gets its normal the first time it passes, without anybody
      having to accept it, because it never had one. */
  waiting?: string[];
};

export const readLast = (root: string, name: string) => readJson<RunRecord | null>(path.join(stateDir(root, name), "last.json"), null);
export const readBaseline = (root: string, name: string) => readJson<Baseline | null>(path.join(baselineDir(root, name), "snapshots.json"), null);
export const readSnapshots = (dir: string) => readJson<Snapshot[]>(path.join(dir, "snapshots.json"), []);

export function writeRun(root: string, rec: RunRecord): void {
  const d = stateDir(root, rec.journey);
  fs.mkdirSync(d, { recursive: true });
  writeJson(path.join(d, "last.json"), rec);
  if (fs.existsSync(rec.dir)) writeJson(path.join(rec.dir, "journey.json"), rec);
  fs.appendFileSync(path.join(d, "runs.jsonl"), JSON.stringify({ at: rec.at, session: rec.session, dir: rec.dir, status: rec.status, scheduled: rec.scheduled }) + "\n");
}

export function readRuns(root: string, name: string): { at: string; session: string; dir: string; status: JourneyStatus; scheduled: boolean }[] {
  let text = "";
  try { text = fs.readFileSync(path.join(stateDir(root, name), "runs.jsonl"), "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** Decode a step's picture from the folder its snapshot belongs to. */
export function loadPicture(folder: string, s: Snapshot) {
  if (!s.shot) return null;
  try { return decodePng(fs.readFileSync(path.join(folder, s.shot))); } catch { return null; }
}

/**
 * Make a run the normal: its snapshots and their pictures become the
 * baseline, whole, or not at all.
 */
export function acceptRun(root: string, name: string, sessionDir: string, sessionId: string, o: { passingOnly?: boolean } = {}): Baseline {
  const all = readSnapshots(sessionDir);
  // A run with a failing step still gives its passing steps a normal; the
  // failing ones wait for their first pass.
  const steps = o.passingOnly ? all.filter((s) => s.result === "pass") : all;
  const waiting = o.passingOnly ? all.filter((s) => s.result !== "pass").map(keyOf) : [];
  if (!steps.length) throw new Error("that run kept nothing to compare with");
  const target = baselineDir(root, name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, "snapshots"), { recursive: true });
  for (const s of steps) if (s.shot && fs.existsSync(path.join(sessionDir, s.shot))) fs.copyFileSync(path.join(sessionDir, s.shot), path.join(tmp, s.shot));
  const b: Baseline = { acceptedAt: new Date().toISOString(), from: sessionId, steps, ...(waiting.length ? { waiting } : {}) };
  writeJson(path.join(tmp, "snapshots.json"), b);
  const old = `${target}.${process.pid}.old`;
  if (fs.existsSync(target)) fs.renameSync(target, old);
  fs.renameSync(tmp, target);
  fs.rmSync(old, { recursive: true, force: true });
  return b;
}

/**
 * Steps the normal was waiting for, now passing: each joins the normal as it
 * is in this run. Returns the keys it took in.
 */
export function adoptWaiting(root: string, name: string, sessionDir: string, after: Snapshot[]): string[] {
  const b = readBaseline(root, name);
  if (!b?.waiting?.length) return [];
  const taken: string[] = [];
  const dir = baselineDir(root, name);
  for (const s of after) {
    const k = keyOf(s);
    if (s.result !== "pass" || !b.waiting.includes(k) || b.steps.some((x) => keyOf(x) === k)) continue;
    let shot: string | null = null;
    if (s.shot && fs.existsSync(path.join(sessionDir, s.shot))) {
      shot = `snapshots/adopted-${String(s.n).padStart(2, "0")}-${Date.now().toString(36)}.png`;
      fs.mkdirSync(path.join(dir, "snapshots"), { recursive: true });
      fs.copyFileSync(path.join(sessionDir, s.shot), path.join(dir, shot));
    }
    b.steps.push({ ...s, shot });
    b.waiting = b.waiting.filter((x) => x !== k);
    taken.push(k);
  }
  if (taken.length) {
    if (!b.waiting.length) delete b.waiting;
    writeJson(path.join(dir, "snapshots.json"), b);
  }
  return taken;
}

/** Accept the newest run of a journey: what the window's one button does. */
export function acceptLast(root: string, name: string): RunRecord {
  const last = readLast(root, name);
  if (!last) throw new Error(`"${name}" has not run yet`);
  if (last.status === "failed") throw new Error(`"${name}" failed on its last run — a failed run cannot be the normal; run it again once it passes`);
  if (last.status === "unchanged") return last;
  const b = acceptRun(root, name, last.dir, last.session);
  const rec: RunRecord = { ...last, status: "unchanged", acceptedAt: b.acceptedAt };
  writeJson(path.join(stateDir(root, name), "last.json"), rec);
  if (fs.existsSync(last.dir)) writeJson(path.join(last.dir, "journey.json"), rec);
  return rec;
}

/**
 * Unchanged nightly runs nobody will look at: every one but the newest goes.
 * A run that changed or failed is kept, and so is any session someone left
 * a note on.
 */
export function pruneQuietRuns(root: string, name: string, keep: string): string[] {
  const removed: string[] = [];
  const baseline = readBaseline(root, name);
  for (const r of readRuns(root, name)) {
    if (r.session === keep || r.status !== "unchanged" || !r.scheduled || r.session === baseline?.from) continue;
    if (!fs.existsSync(path.join(r.dir, "journey.json"))) continue;   // only folders a journey made
    if (readFlagsIn(r.dir).length) continue;
    fs.rmSync(r.dir, { recursive: true, force: true });
    removed.push(r.session);
  }
  return removed;
}

// ---------- words ----------

/** Where a failed run failed, in one line: "failed at step 3: Open Licences — No table",
    or why it could not run at all. */
export function failureLine(rec: Pick<RunRecord, "dir" | "error">): string {
  const st = rec.dir ? readJson<{ n: number; intent: string; note: string; result: string | null }[]>(path.join(rec.dir, "steps.json"), []) : [];
  const f = st.find((s) => s.result === "fail");
  if (f) {
    const note = (f.note || rec.error || "").trim();
    return `failed at step ${f.n}: ${f.intent}${note ? ` — ${note}` : ""}`;
  }
  return `failed${rec.error ? ` — ${rec.error}` : ""}`;
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "3 Dec", with the year only when it is not this one. */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTH[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ""}`;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** When a run was, said honestly, with the clock time while it is recent:
    "last night at 03:02" for the small hours, "today at 11:46",
    "yesterday at 21:21", then "on 3 Dec". The evening before is not "last
    night": a run at 21:21 is yesterday at 21:21. */
export function whenWord(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days === 0 && d.getHours() < 6) return `last night at ${hhmm(d)}`;
  if (days === 0) return `today at ${hhmm(d)}`;
  if (days === 1) return `yesterday at ${hhmm(d)}`;
  return `on ${shortDate(iso, now)}`;
}

/** The same, to the day, for a line about several runs: "last night",
    "today", "yesterday evening", "yesterday", "on 3 Dec". */
export function dayWord(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days === 0 && d.getHours() < 6) return "last night";
  if (days === 0) return "today";
  if (days === 1) return d.getHours() >= 18 ? "yesterday evening" : "yesterday";
  return `on ${shortDate(iso, now)}`;
}

/** The one line under a journey's name. */
export function journeyLine(last: RunRecord | null, baseline: Baseline | null, now = new Date()): string {
  if (!last) return "Not run yet";
  if (last.status === "failed") return `Failed ${whenWord(last.at, now)}`;
  if (last.status === "changed") return `Changed ${whenWord(last.at, now)}`;
  return `Unchanged since ${shortDate(baseline?.acceptedAt ?? last.acceptedAt ?? last.at, now)}`;
}

/** "1 journey changed since last night", or null when nothing did. Each
    kind says its own day when the changes and the failures came on
    different ones: "1 journey changed today and 4 failed yesterday evening". */
export function summaryLine(lasts: (RunRecord | null)[], now = new Date()): string | null {
  const changed = lasts.filter((l) => l?.status === "changed") as RunRecord[];
  const failed = lasts.filter((l) => l?.status === "failed") as RunRecord[];
  if (!changed.length && !failed.length) return null;
  const newest = (rs: RunRecord[]) => rs.map((l) => l.at).sort().at(-1)!;
  const since = (w: string) => w === "last night" ? "since last night" : w;
  const n = (k: number, what: string) => `${k} journey${k === 1 ? "" : "s"} ${what}`;
  if (changed.length && failed.length) {
    const wc = dayWord(newest(changed), now), wf = dayWord(newest(failed), now);
    if (wc === wf) return `${n(changed.length, "changed")} and ${failed.length} failed ${since(wc)}`;
    return `${n(changed.length, "changed")} ${since(wc)} and ${failed.length} failed ${wf}`;
  }
  if (changed.length) return `${n(changed.length, "changed")} ${since(dayWord(newest(changed), now))}`;
  return `${n(failed.length, "failed")} ${dayWord(newest(failed), now)}`;
}

/** What broke and what to do about it, in words a person can act on, from
    a failed run's raw reason. A missing sign-in is the common one: it names
    the site and the one thing that fixes it. */
export function problemOf(reason: string): { broke: string; todo: string | null; signIn: string | null; command: string | null } {
  const r = reason.trim();
  const login = /^no saved login for (\S+) — run `(retake login (\S+))`/.exec(r);
  if (login) return { broke: `There is no saved sign-in for ${login[1]}.`, todo: "Save the test account’s sign-in once. Every journey on that site uses it from then on.", signIn: login[3], command: login[2] };
  return { broke: r, todo: null, signIn: null, command: null };
}

/** Each journey with its line, for the window and for `retake watch`. */
export function journeyStates(root: string, now = new Date()) {
  return listJourneys(root).map((j) => {
    const last = readLast(root, j.name);
    const baseline = readBaseline(root, j.name);
    return { name: j.name, title: last?.title ?? j.name, line: journeyLine(last, baseline, now), status: last?.status ?? null, at: last?.at ?? null, session: last?.session ?? null, last, baseline };
  });
}

// ---------- the nightly schedule, as typed ----------

/** When the nightly run happens unless the person says otherwise: the middle
    of the night, when nobody is using the app or the Mac. */
export const NIGHTLY_AT = "03:00";

/** `retake watch schedule [on|off|daily|weekdays] [--at HH:MM]`: what was
    asked for. Null `every` means "show me the current one". `on` is the one
    switch: the nightly run and a run whenever the app changes. */
export function parseWatchSchedule(every: string | undefined, at: string | undefined): { every: "on" | "daily" | "weekdays" | "off" | null; at: string } {
  const e = every?.trim().toLowerCase();
  const t = (at ?? NIGHTLY_AT).trim();
  if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(t)) throw new Error(`"${t}" is not a time — 24-hour HH:MM, e.g. ${NIGHTLY_AT}`);
  if (!e) return { every: null, at: t };
  if (e !== "on" && e !== "daily" && e !== "weekdays" && e !== "off") throw new Error("say daily, weekdays or off — or on, for each night and whenever the app changes");
  return { every: e, at: t };
}

/** The one notification a night, or null to stay silent. */
export function nightlyNotice(runs: RunRecord[], now = new Date()): { title: string; body: string } | null {
  const loud = runs.filter((r) => r.status !== "unchanged");
  const line = summaryLine(runs, now);
  if (!loud.length || !line) return null;
  return { title: "Retake Watch", body: `${line}: ${loud.map((r) => r.title).join(", ")}`.slice(0, 220) };
}

// ---------- the moment, for the window ----------

export type Moment = {
  n: number;
  intent: string;
  scenario: string | null;
  /** In words: "The text changed", "It failed, and passed before"… */
  what: string;
  note: string;
  text: { added: string[]; removed: string[] } | null;
  /** Pictures: the accepted run's (in the baseline folder) and this run's (in the session). */
  before: string | null;
  after: string | null;
  box: { x: number; y: number; width: number; height: number } | null;
  /** The few seconds of the session's video that show it, in seconds. */
  clip: { start: number; end: number } | null;
};

/** A step that starts the session (before this) and lasts less than CLIP_MIN_MS
    gets no clip on the changed screen, only its pictures. */
export const SESSION_START_MS = 500;
export const CLIP_MIN_MS = 2000;

/** The one moment a changed or failed journey opens to: the first step
    that changed, or the step that failed. */
export function momentOf(rec: RunRecord, baseline: Baseline | null, after: Snapshot[], steps: { n: number; note: string; t: number; tEnd: number | null }[] = []): Moment | null {
  let m: Moment | null = null;
  // From the moment the step begins (its action, then the screen it leads to), and a breath after.
  // A step that opens the session and is over in a moment (a one-step journey's
  // page opening) has only a blank page before it and the end of the video after
  // it: a second of white. The two pictures say it better.
  const clipOf = (t: number | null, tEnd: number | null) => (t === null || (t < SESSION_START_MS && tEnd !== null && tEnd - t < CLIP_MIN_MS) ? null : { start: Math.max(0, (t - 300) / 1000), end: ((tEnd ?? t + 3000) + 1500) / 1000 });
  if (rec.status === "failed") {
    const a = after.find((s) => s.result !== "pass") ?? after.at(-1);
    if (!a) return null;
    const c = rec.changes.find((x) => x.n === a.n && x.after === a.shot);
    const b = baseline ? matchSteps(baseline.steps, after).pairs.find(([, x]) => x === a)?.[0] ?? null : null;
    const st = steps.find((s) => s.n === a.n);
    m = { n: a.n, intent: a.intent, scenario: a.scenario, what: "It failed", note: st?.note || rec.error || "", text: c?.text ?? null, before: b?.shot ?? null, after: a.shot, box: c?.picture?.box ?? null, clip: clipOf(a.t, a.tEnd) };
  } else if (rec.status === "changed" && rec.changes.length) {
    const c = rec.changes[0];
    const st = steps.find((s) => s.n === c.n);
    m = { n: c.n, intent: c.intent, scenario: c.scenario, what: describeChange(c), note: st?.note ?? "", text: c.text ?? null, before: c.before, after: c.after, box: c.picture?.box ?? null, clip: clipOf(c.t ?? st?.t ?? null, c.tEnd ?? st?.tEnd ?? null) };
  }
  return m;
}
