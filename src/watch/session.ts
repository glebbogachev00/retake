/**
 * Watch mode, the parts that are only data.
 *
 * A watch session is a person sitting with an AI while it tests their app:
 * the AI says what it is about to do and what it expects, does it, and says
 * whether it worked. The person can stop it on any moment that worked but did
 * not look clear. Everything here is what that leaves on disk, and the few
 * decisions (how long to pause, which step a moment belongs to) that both the
 * script side (src/watch.ts) and the window (src/ui/watch-routes.ts) have to
 * make the same way.
 *
 * The folder is the record. steps.json and flags.json are written as the
 * session goes, so a script that dies half-way, or a window that is closed,
 * loses nothing that already happened.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export type Speed = "watch" | "step" | "fast";
export const SPEEDS: Speed[] = ["watch", "step", "fast"];
export const isSpeed = (s: unknown): s is Speed => typeof s === "string" && (SPEEDS as string[]).includes(s);

/** Human pace: the hold on each new screen. */
export const WATCH_PAUSE_MS = 1500;
/** Long enough to read what the AI is about to do before it does it. */
export const WATCH_INTENT_MS = 700;

export type StepRecord = {
  n: number;
  scenario: string | null;
  intent: string;
  expect: string;
  result: "pass" | "fail" | null;
  note: string;
  startedAt: string;
  endedAt: string | null;
  /** Milliseconds from the start of the session — the same clock as the video. */
  t: number;
  tEnd: number | null;
  url: string;
  /** Relative to the session folder. */
  screenshot: string | null;
};

export type FlagRecord = {
  n: number;
  /** "unclear": pressed Unclear. "note": typed a note without it. */
  kind: "unclear" | "note";
  step: number | null;
  /** Seconds into the session (and its video). */
  time: number;
  at: string;
  note: string;
  screenshot: string | null;
  url: string;
  source: "live" | "replay";
  /** The fix request this went out in, once it has. */
  fix?: string;
};

export type SessionMeta = {
  id: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  video: string | null;
  /** How the session ended, when it did not end cleanly. */
  problem?: string;
};

// ---------- names ----------

export const slugify = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "session";

/** YYYYMMDD-HHMM in local time: the minute the session started. */
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** A folder name nobody else has taken: `<slug>-<stamp>`, then `-2`, `-3`… */
export function sessionId(title: string, d: Date, taken: (id: string) => boolean): string {
  const base = `${slugify(title)}-${stamp(d)}`;
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

export const safeId = (s: string) => /^[a-z0-9][a-z0-9-]{0,80}$/.test(s);

// ---------- time ----------

/** Which step a moment belongs to: the one running then, or the last one
    that had started (steps run one after another, so that is the same
    thing). Before the first step, none. */
export function stepAt(steps: StepRecord[], ms: number): number | null {
  let best: StepRecord | null = null;
  for (const s of steps) if (s.t <= ms && (!best || s.t >= best.t)) best = s;
  return best ? best.n : null;
}

export const clock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ---------- the pause between steps ----------

/**
 * Whether the run may go on now, or how long to wait before asking again.
 *
 * Next always lets it go. Fast never waits. Watch holds the screen for
 * WATCH_PAUSE_MS, longer while the person is writing a note. Step waits for
 * Next — unless nobody can press it, because no window is open.
 */
export function gateDecision(s: { speed: Speed; elapsedMs: number; pressed: boolean; hold: boolean; ui: boolean; pauseMs?: number }): { go: true } | { go: false; waitMs: number } {
  if (s.pressed) return { go: true };
  if (s.speed === "fast") return { go: true };
  if (s.hold && s.ui) return { go: false, waitMs: 1000 };
  if (s.speed === "step" && s.ui) return { go: false, waitMs: 25_000 };
  const left = (s.pauseMs ?? WATCH_PAUSE_MS) - s.elapsedMs;
  return left <= 0 ? { go: true } : { go: false, waitMs: left };
}

// ---------- masks ----------

/** Things only Playwright's own selector engine understands. A CSS selector
    can be applied by the page itself from its first paint; these cannot, so
    they are found by Playwright and marked instead. */
export function isCssSelector(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (/^(text|role|xpath|id|data-testid|internal|css|nth|visible|label|placeholder|alt|title)[:=]/i.test(t)) return false;
  if (t.startsWith("//") || t.startsWith("..") || /^["']/.test(t)) return false;
  if (t.includes(">>")) return false;
  if (/:(has-text|text|text-is|text-matches|visible|nth-match|left-of|right-of|above|below|near)\(/.test(t)) return false;
  return true;
}

/** The selectors currently hidden, in the order they were asked for. */
export class MaskList {
  private items: string[] = [];
  add(sel: string): boolean { const s = sel.trim(); if (!s || this.items.includes(s)) return false; this.items.push(s); return true; }
  remove(sel: string): boolean { const i = this.items.indexOf(sel.trim()); if (i < 0) return false; this.items.splice(i, 1); return true; }
  has(sel: string) { return this.items.includes(sel.trim()); }
  list(): string[] { return [...this.items]; }
  get size() { return this.items.length; }
}

// ---------- video ----------

/** Width and height of a JPEG, from its frame header. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * An ffmpeg concat list that plays the frames at the moments they arrived.
 * The screencast only sends a frame when the screen changes, so each frame
 * is held until the next one — and the first is shown from the start of the
 * session, the last until its end.
 */
export function concatList(frames: { file: string; t: number }[], endMs: number): string {
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(endMs, f.t + 40);
    const start = i === 0 ? 0 : f.t;
    lines.push(`file '${f.file.replace(/'/g, "'\\''")}'`, `duration ${(Math.max(next - start, 1) / 1000).toFixed(3)}`);
  });
  // The concat demuxer drops the last duration unless the file is repeated.
  if (frames.length) lines.push(`file '${frames[frames.length - 1].file.replace(/'/g, "'\\''")}'`);
  return lines.join("\n") + "\n";
}

// ---------- the folder ----------

export const readJson = <T>(f: string, fallback: T): T => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")) as T; } catch { return fallback; }
};
/** Written whole, then renamed: a reader never sees half a file. */
export function writeJson(f: string, v: unknown): void {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n");
  fs.renameSync(tmp, f);
}

export const readSteps = (dir: string) => readJson<StepRecord[]>(path.join(dir, "steps.json"), []);
export const readFlagsIn = (dir: string) => readJson<FlagRecord[]>(path.join(dir, "flags.json"), []);
export const readMeta = (dir: string) => readJson<SessionMeta | null>(path.join(dir, "session.json"), null);
export const writeSteps = (dir: string, steps: StepRecord[]) => writeJson(path.join(dir, "steps.json"), steps);
export const writeFlagsIn = (dir: string, flags: FlagRecord[]) => writeJson(path.join(dir, "flags.json"), flags);
export const writeMeta = (dir: string, meta: SessionMeta) => writeJson(path.join(dir, "session.json"), meta);

/** Add one flag, numbered after the last. Returns it as written. */
export function appendFlag(dir: string, f: Omit<FlagRecord, "n">): FlagRecord {
  const flags = readFlagsIn(dir);
  const flag: FlagRecord = { n: (flags.at(-1)?.n ?? 0) + 1, ...f };
  writeFlagsIn(dir, [...flags, flag]);
  return flag;
}

export function updateFlag(dir: string, n: number, patch: Partial<Pick<FlagRecord, "note" | "fix">>): FlagRecord | null {
  const flags = readFlagsIn(dir);
  const f = flags.find((x) => x.n === n);
  if (!f) return null;
  Object.assign(f, patch);
  writeFlagsIn(dir, flags);
  return f;
}

// ---------- report ----------

const mark = (s: StepRecord, flagged: boolean) => (flagged ? "flagged" : s.result === "pass" ? "pass" : s.result === "fail" ? "fail" : "unfinished");

export function renderReport(meta: SessionMeta, steps: StepRecord[], flags: FlagRecord[]): string {
  const flaggedSteps = new Set(flags.map((f) => f.step).filter((n): n is number => n !== null));
  const passed = steps.filter((s) => s.result === "pass").length;
  const failed = steps.filter((s) => s.result === "fail").length;
  const out: string[] = [`# ${meta.title}`, ""];
  out.push(`${new Date(meta.startedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · ${steps.length} step${steps.length === 1 ? "" : "s"} · ${passed} passed · ${failed} failed · ${flags.length} flagged by you`);
  if (meta.video) out.push("", `Video: [${meta.video}](${meta.video})`);
  if (meta.problem) out.push("", `Note: ${meta.problem}`);
  out.push("");
  if (flags.length) {
    out.push("## Flagged by you", "");
    for (const f of flags) {
      const s = steps.find((x) => x.n === f.step);
      const what = s ? `Step ${s.n}: ${s.intent}` : "Before the first step";
      const note = f.note ? ` — “${f.note}”` : f.kind === "unclear" ? " — unclear (no note)" : "";
      const shot = f.screenshot ? ` [screenshot](${f.screenshot})` : "";
      out.push(`${f.n}. ${what} (${f.source}, ${clock(f.time)})${note}${shot}${f.url ? ` — ${f.url}` : ""}`);
    }
    out.push("");
  }
  out.push("## Steps", "");
  let scenario: string | null | undefined;
  for (const s of steps) {
    if (s.scenario !== scenario) {
      scenario = s.scenario;
      if (scenario) out.push("", `### ${scenario}`, "");
    }
    const shot = s.screenshot ? ` [screenshot](${s.screenshot})` : "";
    out.push(`- ${mark(s, flaggedSteps.has(s.n))}: ${s.intent} — expected: ${s.expect}${s.note ? ` — ${s.note}` : ""}${shot}`);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function writeReport(dir: string): void {
  const meta = readMeta(dir);
  if (!meta) return;
  fs.writeFileSync(path.join(dir, "report.md"), renderReport(meta, readSteps(dir), readFlagsIn(dir)));
}

// ---------- fix requests ----------

/** Flags that have not gone out in a fix request yet. */
export const unsent = (flags: FlagRecord[]) => flags.filter((f) => !f.fix);

/** The next free name: fix-request, then fix-request-2, -3… */
export function nextFixName(dir: string): string {
  if (!fs.existsSync(path.join(dir, "fix-request.json"))) return "fix-request";
  for (let i = 2; ; i++) if (!fs.existsSync(path.join(dir, `fix-request-${i}.json`))) return `fix-request-${i}`;
}

export type FixNote = {
  flag: number; note: string; kind: FlagRecord["kind"]; source: FlagRecord["source"];
  time: string; at: string; url: string; screenshot: string | null;
  step: { n: number; scenario: string | null; intent: string; expect: string; result: StepRecord["result"]; note: string } | null;
};

export function fixNotes(dir: string, steps: StepRecord[], flags: FlagRecord[]): FixNote[] {
  return flags.map((f) => {
    const s = steps.find((x) => x.n === f.step);
    return {
      flag: f.n, note: f.note, kind: f.kind, source: f.source, time: clock(f.time), at: f.at, url: f.url,
      screenshot: f.screenshot ? path.join(dir, f.screenshot) : null,
      step: s ? { n: s.n, scenario: s.scenario, intent: s.intent, expect: s.expect, result: s.result, note: s.note } : null,
    };
  });
}

export function renderFixBrief(meta: SessionMeta, dir: string, notes: FixNote[]): string {
  const out = [
    `# Fix request: ${meta.title}`,
    "",
    `A person watched an AI test this app and flagged ${notes.length === 1 ? "one moment" : `${notes.length} moments`} that worked but did not look clear. Each one below is what they saw and what they said. Make each moment clear; do not change what the app does unless the note asks for it.`,
    "",
    `Session folder: ${dir}`,
    "",
  ];
  notes.forEach((n, i) => {
    out.push(`## ${i + 1}. ${n.note ? `“${n.note}”` : "Unclear (no note written)"}`, "");
    if (n.step) {
      out.push(`- Step ${n.step.n}${n.step.scenario ? ` (${n.step.scenario})` : ""}: ${n.step.intent}`);
      out.push(`- Expected: ${n.step.expect}`);
      out.push(`- Result: ${n.step.result ?? "unfinished"}${n.step.note ? ` — ${n.step.note}` : ""}`);
    } else out.push("- Before the first step");
    out.push(`- URL: ${n.url || "(unknown)"}`);
    out.push(`- At: ${n.time} into the session (${n.at}), flagged ${n.source}`);
    out.push(`- Screenshot: ${n.screenshot ?? "(none)"}`, "");
  });
  return out.join("\n");
}

export type QueueLine = { dir: string; request: string; notes: number; at: string; status: string };
export const queueFile = (watchRoot: string) => path.join(watchRoot, "fix-queue.jsonl");

/**
 * Send every unsent flag of a session as one fix request: the brief as
 * JSON and as plain text in the folder, each flag marked with the request it
 * went in, and one line on the queue an agent watches. Null when there is
 * nothing to send.
 */
export function writeFixRequest(dir: string): { name: string; json: string; md: string; notes: number } | null {
  const meta = readMeta(dir);
  const flags = readFlagsIn(dir);
  const todo = unsent(flags);
  if (!meta || !todo.length) return null;
  const steps = readSteps(dir);
  const name = nextFixName(dir);
  const notes = fixNotes(dir, steps, todo);
  const json = path.join(dir, `${name}.json`), md = path.join(dir, `${name}.md`);
  writeJson(json, { title: meta.title, dir, request: name, at: new Date().toISOString(), notes });
  fs.writeFileSync(md, renderFixBrief(meta, dir, notes));
  const sentNs = new Set(todo.map((f) => f.n));
  writeFlagsIn(dir, flags.map((f) => (sentNs.has(f.n) ? { ...f, fix: name } : f)));
  const line: QueueLine = { dir, request: name, notes: todo.length, at: new Date().toISOString(), status: "sent" };
  fs.appendFileSync(queueFile(path.dirname(dir)), JSON.stringify(line) + "\n");
  return { name, json, md, notes: todo.length };
}

/** The newest status of each request, read off the queue. An agent that
    picks one up appends (or rewrites) its line with `picked`, `pr <url>`
    or `done`; the last word wins. */
export function queueStatus(watchRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  let text = "";
  try { text = fs.readFileSync(queueFile(watchRoot), "utf8"); } catch { return out; }
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try { const l = JSON.parse(raw) as QueueLine; if (l.dir && l.request) out.set(`${l.dir}#${l.request}`, String(l.status ?? "")); } catch { /* a bad line is skipped */ }
  }
  return out;
}

/** The optional fixer: the person's own command, in their repo, brief on stdin. */
export function runFix(fix: { repo: string; command: string }, briefFile: string): void {
  try {
    const log = fs.openSync(briefFile.replace(/\.md$/, ".log"), "a");
    const p = spawn(fix.command, { cwd: fix.repo, shell: true, stdio: ["pipe", log, log], detached: true });
    p.stdin?.end(fs.readFileSync(briefFile));
    p.unref();
  } catch (e) { process.stderr.write(`retake watch: could not start the fix command: ${(e as Error).message}\n`); }
}
