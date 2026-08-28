/**
 * What this run is doing right now, on disk.
 *
 * The window used to know only what something chose to tell it. An agent
 * driving Retake over MCP reported progress; a person running `retake run` in
 * a terminal reported nothing — so a seventeen-minute recording looked
 * identical to an idle machine, and the honest answer to "what is it doing?"
 * was "no idea".
 *
 * A file fixes that for every caller at once. The run writes where it is, the
 * window reads it, and nobody has to be told anything. Same principle as the
 * lock: state that outlives the process that made it, readable by anyone who
 * can see the folder.
 *
 * Written best-effort and read defensively. A progress note must never be a
 * reason a recording fails, and a stale one must never be mistaken for a live
 * one — which is what `startedAt` and the folder's own lock are for.
 */
import fs from "node:fs";
import path from "node:path";

export type Phase = "seeding" | "opening" | "recording" | "rendering" | "checking" | "done" | "failed";

export type Progress = {
  demo: string;
  phase: Phase;
  /** Where in the phase, when the phase has a shape. */
  step?: number;
  of?: number;
  /** The step or stage, in the words the log uses. */
  label?: string;
  /** When this run began — the whole run, not this phase. */
  startedAt: string;
  at: string;
  pid: number;
};

const FILE = "progress.json";
const file = (outDir: string) => path.join(outDir, FILE);

/** Start of a run: the clock the window counts from. */
export function beginProgress(outDir: string, demo: string): void {
  write(outDir, { demo, phase: "opening", startedAt: new Date().toISOString(), at: new Date().toISOString(), pid: process.pid });
}

export function setPhase(outDir: string, p: Partial<Progress> & { phase: Phase }): void {
  const now = read(outDir);
  write(outDir, {
    demo: p.demo ?? now?.demo ?? path.basename(outDir),
    startedAt: now?.startedAt ?? new Date().toISOString(),
    pid: process.pid,
    ...p,
    at: new Date().toISOString(),
  } as Progress);
}

export function endProgress(outDir: string): void {
  try { fs.rmSync(file(outDir), { force: true }); } catch { /* going away anyway */ }
}

function write(outDir: string, p: Progress): void {
  try {
    if (!fs.existsSync(outDir)) return;
    fs.writeFileSync(file(outDir), JSON.stringify(p));
  } catch { /* a progress note is never worth failing a run for */ }
}

export function read(outDir: string): Progress | null {
  try {
    const p = JSON.parse(fs.readFileSync(file(outDir), "utf8")) as Progress;
    return p && typeof p.phase === "string" ? p : null;
  } catch { return null; }
}

/**
 * Is this progress from a process that still exists?
 *
 * A run killed with a signal leaves its note behind. Showing that as live
 * work is worse than showing nothing — the window would claim a recording is
 * in progress forever.
 */
export function isLive(p: Progress | null): boolean {
  if (!p || !p.pid) return false;
  try { process.kill(p.pid, 0); return true; } catch { return false; }
}

/** Everything happening in this workspace right now, newest first. */
export function running(outRoot: string): Progress[] {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(outRoot); } catch { return []; }
  const out: Progress[] = [];
  for (const d of dirs) {
    if (d.startsWith(".")) continue;
    const p = read(path.join(outRoot, d));
    if (p && isLive(p) && p.phase !== "done") out.push(p);
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
