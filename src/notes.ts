/**
 * The watcher: what everyone has actually been doing, read back to them.
 *
 * Not a process monitor. Watching processes tells you a chromium is running;
 * it cannot tell you that three agents recorded the same demo at full quality
 * six times because none of them knew about `--from`. The evidence for that
 * is already on disk — every run leaves a take, the manifest it used, and the
 * takes it replaced — and nobody has ever read it back.
 *
 * So this reads `outputs/` and says the few things a person would say after
 * looking through it. Every note has to be provable from a file; nothing here
 * guesses at intent. And it is deliberately quiet: with nothing to report it
 * prints one line and stops, because a report that always has something in it
 * is a report nobody opens twice.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Take } from "./record.js";

export type Note = {
  /** problem: something shipped wrong. cost: time being spent for nothing.
      habit: a procedure being skipped, which is the one worth a policy. */
  kind: "problem" | "cost" | "habit";
  line: string;
  demos: string[];
  /** A sentence to put in AGENTS.md, when the note is about how people work
      rather than about one broken take. */
  policy?: string;
};

type Run = {
  name: string;
  dir: string;
  take: Take | null;
  used: Record<string, unknown> | null;
  /** Prior takes this demo has replaced, kept under .history/ and .previous/. */
  priors: number;
  when: number;
};

const mins = (s: number) => (s >= 90 ? `${Math.round(s / 60)} minutes` : `${Math.round(s)} seconds`);
const list = (xs: string[]) => (xs.length <= 3 ? xs.join(", ") : `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more`);

function readRun(dir: string): Run | null {
  const name = path.basename(dir);
  if (name.startsWith(".")) return null;
  const read = <T,>(f: string): T | null => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as T; } catch { return null; }
  };
  const take = read<Take>("take.json");
  let used: Record<string, unknown> | null = null;
  try { used = YAML.parse(fs.readFileSync(path.join(dir, "manifest.used.yaml"), "utf8")) as Record<string, unknown>; } catch { /* older runs */ }
  const count = (sub: string) => { try { return fs.readdirSync(path.join(dir, sub)).length; } catch { return 0; } };
  const priors = count(".history") + (fs.existsSync(path.join(dir, ".previous")) ? 1 : 0);
  const when = take?.finishedAt ? Date.parse(take.finishedAt) : (() => {
    try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
  })();
  if (!take && !used) return null; // an empty folder is not a run
  return { name, dir, take, used, priors, when };
}

/** Every scene label in a used manifest that carries no `expect:`. */
function scenesWithoutExpect(used: Record<string, unknown> | null): number {
  const steps = (used?.steps as { action?: string; expect?: unknown }[] | undefined) ?? [];
  return steps.filter((s) => s.action === "scene" && !s.expect).length;
}

/** The selector a failed step was reaching for, when it named one. */
function failedSelector(summary: string, error: string): string | null {
  const m = /((?:[.#\[a-zA-Z][^\s"']*)?(?:has-text|getByRole)?\([^)]*\)|[.#][A-Za-z][\w-]*(?:\[[^\]]*\])?)/.exec(summary);
  if (m) return m[0].slice(0, 60);
  const t = /(?:waiting for|selector)\s+([^\s,]+)/i.exec(error);
  return t ? t[1].slice(0, 60) : null;
}

export function collect(root: string, sinceDays = 14): { runs: Run[]; notes: Note[] } {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.statSync(d).isDirectory()); } catch { /* no outputs yet */ }
  const cutoff = Date.now() - sinceDays * 86_400_000;
  const runs = dirs.map(readRun).filter((r): r is Run => !!r && r.when >= cutoff).sort((a, b) => b.when - a.when);
  const notes: Note[] = [];
  const add = (n: Note) => { if (n.demos.length) notes.push(n); };

  // --- problems: something on disk is wrong right now ----------------------

  // A video that ends on an app error ends broken, and nothing else says so.
  const broken = runs.filter((r) => {
    const errs = r.take?.pageErrors ?? [];
    return errs.some((e) => e.at >= (r.take!.duration - 3));
  }).map((r) => r.name);
  add({ kind: "problem", demos: broken, line: `The app threw an error in the last seconds of ${list(broken)} — whatever those videos end on, it is a broken screen.` });

  // `partial` covers two opposite things, and reading it as one is how a
  // watcher starts crying wolf: a `--from`/`--until` fragment is the cheap
  // iteration path working exactly as intended, while a raw fallback or an
  // abort is a take that failed and kept a video anyway. Only the second is
  // a problem.
  const FRAGMENT = /\((?:from|until)\)/;
  const fallback = runs.filter((r) => r.take?.partial && !FRAGMENT.test(r.take.partial)).map((r) => r.name);
  add({ kind: "problem", demos: fallback, line: `${list(fallback)} kept a video from a run that did not finish cleanly — check the take before anyone sends ${fallback.length === 1 ? "it" : "them"} on.` });

  // A fragment is fine to make and easy to forget: outputs/<name>/demo.mp4 is
  // then a piece of the demo, sitting where the finished cut used to be.
  const fragment = runs.filter((r) => r.take?.partial && FRAGMENT.test(r.take.partial)).map((r) => r.name);
  add({ kind: "cost", demos: fragment, line: `The newest take of ${list(fragment)} is a fragment from iterating, not the whole demo. If ${fragment.length === 1 ? "that demo is" : "those are"} finished, ${fragment.length === 1 ? "it needs" : "they need"} one full run.` });

  // A stub that answered nothing means the take showed live data where it
  // meant to show canned. The take passes; the demo is a lie.
  const deadStub = runs.filter((r) => Object.values(r.take?.stubHits ?? {}).some((n) => n === 0)).map((r) => r.name);
  add({ kind: "problem", demos: deadStub, line: `A stub in ${list(deadStub)} never answered a single request — that recording is showing live data where it was meant to show canned.` });

  // The same selector failing in more than one demo is the app having moved,
  // not the demos being badly written. Worth saying once instead of N times.
  const bySelector = new Map<string, Set<string>>();
  for (const r of runs) {
    for (const t of r.take?.timeline ?? []) {
      if (t.ok) continue;
      const sel = failedSelector(t.summary ?? "", t.error ?? "");
      if (!sel) continue;
      if (!bySelector.has(sel)) bySelector.set(sel, new Set());
      bySelector.get(sel)!.add(r.name);
    }
  }
  for (const [sel, where] of bySelector) {
    if (where.size < 2) continue;
    add({ kind: "problem", demos: [...where], line: `\`${sel}\` failed in ${where.size} different demos (${list([...where])}). That is the app having changed, not the demos being wrong — fix it once.` });
  }

  // A lock left behind by a run that died blocks the folder forever, and the
  // next agent gets a refusal it cannot explain.
  const stale = runs.filter((r) => {
    const lock = path.join(r.dir, ".retake-lock");
    try { return Date.now() - fs.statSync(lock).mtimeMs > 60 * 60_000; } catch { return false; }
  }).map((r) => r.name);
  add({ kind: "problem", demos: stale, line: `${list(stale)} still has a lock on it from over an hour ago. If nothing is recording, that is a dead run holding the folder — delete outputs/<name>/.retake-lock.` });

  // --- cost: time being spent that did not need spending -------------------

  // Re-recording a long demo at full quality is the single most expensive
  // habit there is, and it is always avoidable.
  const churn = runs.filter((r) => r.priors >= 2 && (r.take?.captureSec ?? 0) > 120 && r.take?.quality.preset !== "draft");
  for (const r of churn) {
    const each = r.take!.captureSec!;
    add({
      kind: "cost",
      demos: [r.name],
      line: `${r.name} has been recorded ${r.priors + 1} times at full quality, ${mins(each)} a go — about ${mins(each * (r.priors + 1))} of camera. \`--preset draft\` while it is still changing, and \`--from <scene>\` when only the end moved.`,
    });
  }

  // Disk: the takes are the big files and nobody deletes them.
  let bytes = 0;
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); try { if (e.isDirectory()) walk(f); else bytes += fs.statSync(f).size; } catch { /* gone */ } } };
  try { walk(root); } catch { /* none */ }
  const gb = bytes / 1e9;
  if (gb > 3) add({ kind: "cost", demos: ["outputs"], line: `outputs/ is ${gb.toFixed(1)} GB. \`retake tidy\` shows what it would free before it removes anything, and never touches a recording.` });

  // --- habits: the ones worth a policy -------------------------------------

  // Nobody is checking the picture. This is the note the whole watcher exists
  // for: a demo recorded repeatedly with no `expect:` anywhere is one nobody
  // is verifying, and every visual bug this project has shipped got through
  // exactly that gap.
  const unchecked = runs.filter((r) => r.priors >= 1 && scenesWithoutExpect(r.used) >= 2).map((r) => r.name);
  add({
    kind: "habit",
    demos: unchecked,
    line: `${list(unchecked)} ${unchecked.length === 1 ? "has" : "have"} been recorded more than once with no \`expect:\` on any scene — so nothing has ever checked how ${unchecked.length === 1 ? "it looks" : "they look"}, only that the steps ran.`,
    policy: "Every scene that shows something worth showing carries an `expect:` sentence, and `retake verify` runs before a demo is called finished.",
  });

  // (There was a note here about captions being turned back on. It was cut:
  // `manifest.used.yaml` is the RESOLVED manifest, so `captions: true` in it
  // is as likely to be the default from the day it was recorded as somebody's
  // choice — and it flagged four demos recorded before the default changed.
  // A note that cannot tell intent from history does not belong in a report
  // whose whole value is that everything in it is true.)

  return { runs, notes };
}

/** The report. Quiet by default: the five that matter, problems first. */
export function notes(root: string, opts: { all?: boolean; days?: number } = {}): { lines: string[]; notes: Note[] } {
  const { runs, notes: found } = collect(root, opts.days ?? 14);
  const rank = { problem: 0, cost: 1, habit: 2 } as const;
  const sorted = [...found].sort((a, b) => rank[a.kind] - rank[b.kind]);
  const shown = opts.all ? sorted : sorted.slice(0, 5);
  const lines: string[] = [];

  if (!runs.length) return { lines: ["Nothing recorded in the last two weeks — nothing to read back."], notes: [] };
  if (!found.length) return { lines: [`${runs.length} demo${runs.length === 1 ? "" : "s"} recorded, nothing worth flagging.`], notes: [] };

  lines.push(`Across ${runs.length} demo${runs.length === 1 ? "" : "s"}:`);
  lines.push("");
  for (const n of shown) lines.push(`  ${n.kind === "problem" ? "✗" : n.kind === "cost" ? "·" : "→"} ${n.line}`);
  if (sorted.length > shown.length) lines.push(`\n  (${sorted.length - shown.length} more — \`retake notes --all\`)`);

  const policies = shown.map((n) => n.policy).filter((p): p is string => !!p);
  if (policies.length) {
    lines.push("");
    lines.push(policies.length === 1 ? "Worth writing down, in AGENTS.md:" : "Worth writing down, in AGENTS.md:");
    for (const p of policies) lines.push(`  "${p}"`);
  }
  return { lines, notes: sorted };
}
