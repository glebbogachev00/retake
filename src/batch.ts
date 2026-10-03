/**
 * Many demos, one command.
 *
 * Every take already runs in its own browser, in its own temporary folder,
 * behind its own folder lock — so two `retake run`s in two terminals have
 * always worked. What was missing is the part a person (or an agent) does by
 * hand: run the cheap checks first, start no more takes than the machine can
 * record smoothly, keep demos that share a backend apart, and say at the end
 * which ones are good, in one place.
 *
 *   retake batch                         every manifest in demos/
 *   retake batch demos/a.yaml demos/b.yaml --preset draft -j 3
 *
 * Each demo goes validate → dry → run (record + render + check) → compare
 * (when it says `like:`). Each stage is the ordinary CLI in a child process,
 * so a batch take is exactly the take `retake run` would have made — same
 * stash-and-keep of the previous take, same proof log, same exit codes — and
 * one demo crashing cannot take the others down with it.
 *
 * The report lands in outputs/.batch/<when>/report.md (and .json), with one
 * log per demo beside it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadManifest, warnings, type Manifest } from "./manifest.js";
import { check } from "./render.js";
import { compareTake, planNotes, type Reference, type Verdict } from "./reference.js";
import type { Take } from "./record.js";
import { entry } from "./paths.js";

export type Stage = "queued" | "validate" | "dry" | "record" | "compare" | "done";

export type BatchItem = {
  file: string;
  name: string;
  /** The manifest's `lock:` — demos sharing one never run at the same time. */
  lock?: string;
  stage: Stage;
  ok?: boolean;
  /** One line: why it stopped, or what it came out as. */
  result?: string;
  seconds?: number;
  log: string;
  outDir: string;
  check?: string[];
  compare?: { reference: string; verdicts: Verdict[] };
  startedAt?: string;
  finishedAt?: string;
};

export type BatchOptions = {
  files: string[];
  outRoot: string;
  parallel: number;
  preset?: string;
  /** Skip the dry run. Faster; a selector that moved costs a whole take instead of ten seconds. */
  noDry?: boolean;
  /** Stop after the dry run — check every demo still works without recording any. */
  dryOnly?: boolean;
  /** Passed to every `run`. */
  noMaster?: boolean;
  brisk?: boolean;
  log?: (line: string) => void;
};

export type BatchReport = {
  startedAt: string;
  finishedAt?: string;
  parallel: number;
  preset?: string;
  dir: string;
  items: BatchItem[];
};

/** How many takes at once, when nobody says. Each take is a Chromium plus,
    afterwards, an ffmpeg encode, and the browser's screencast is the first
    thing to give when the CPU runs out: the take stays correct and starts to
    stutter. Measured on 4 cores, a box sliding across the page at 1080p, as
    the share of frames that differ from the one before (ffmpeg mpdecimate):
    alone 55–56%, two at once 57–58%, four at once 26–31%. Half the cores is
    free; all of them halves the motion. Capped at 3 because nobody has
    measured more on a real laptop yet. */
export function defaultParallel(cores = os.cpus().length): number {
  return Math.max(1, Math.min(3, Math.floor(cores / 2)));
}

/** The manifests a bare `retake batch` means: demos/*.yaml|yml|json, minus
    the files that live beside manifests without being one. */
export function discover(demosDir: string): string[] {
  if (!fs.existsSync(demosDir)) return [];
  return fs.readdirSync(demosDir)
    .filter((f) => /\.(ya?ml|json)$/.test(f) && !/\.flags\.json$/.test(f) && !f.startsWith("."))
    .sort()
    .map((f) => path.join(demosDir, f));
}

/** Which queued item may start now: the first one whose output folder and
    shared lock are both free. Pure, so the scheduling rule is testable
    without a browser. Returns -1 when everything left is waiting on a lock. */
export function pickNext(items: Pick<BatchItem, "stage" | "name" | "lock">[]): number {
  const busy = items.filter((i) => i.stage !== "queued" && i.stage !== "done");
  const names = new Set(busy.map((i) => i.name));
  const locks = new Set(busy.flatMap((i) => (i.lock ? [i.lock] : [])));
  return items.findIndex((i) => i.stage === "queued" && !names.has(i.name) && !(i.lock && locks.has(i.lock)));
}

export async function runBatch(o: BatchOptions): Promise<BatchReport> {
  const say = o.log ?? (() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const dir = path.join(o.outRoot, ".batch", stamp);
  fs.mkdirSync(dir, { recursive: true });
  const report: BatchReport = { startedAt: new Date().toISOString(), parallel: o.parallel, ...(o.preset ? { preset: o.preset } : {}), dir, items: [] };
  const save = () => {
    try {
      fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
      fs.writeFileSync(path.join(dir, "report.md"), renderReport(report));
    } catch { /* a report must never be why a batch fails */ }
  };

  // Validate everything up front, in-process: a typo should not wait in a
  // queue behind three recordings to be reported.
  const loaded = new Map<BatchItem, { manifest: Manifest; reference?: Reference }>();
  for (const file of o.files) {
    const base = path.basename(file).replace(/\.(ya?ml|json)$/, "");
    const item: BatchItem = { file: path.resolve(file), name: base, stage: "validate", log: path.join(dir, `${base}.log`), outDir: path.resolve(o.outRoot, base) };
    report.items.push(item);
    try {
      const l = loadManifest(file);
      item.name = l.manifest.name;
      item.lock = l.manifest.lock;
      item.outDir = path.resolve(o.outRoot, l.manifest.name);
      item.log = path.join(dir, `${l.manifest.name}.log`);
      const notes = [...warnings(l.manifest).map((w) => `⚠ ${w}`), ...(l.reference ? planNotes(l.manifest, l.reference.ref).map((w) => `like ${l.reference!.ref.name}: ${w}`) : [])];
      fs.writeFileSync(item.log, notes.length ? notes.join("\n") + "\n" : "");
      loaded.set(item, { manifest: l.manifest, reference: l.reference?.ref });
      item.stage = "queued";
    } catch (e) {
      finish(item, false, (e as Error).message.split("\n").slice(0, 3).join(" "));
      fs.writeFileSync(item.log, (e as Error).message + "\n");
      say(`✗ ${item.name}: ${item.result}`);
    }
  }
  // Two manifests that write to the same output folder would stash each
  // other's takes. Refuse the second rather than let the lock decide.
  const byName = new Map<string, BatchItem>();
  for (const i of report.items) {
    if (i.stage !== "queued") continue;
    const prev = byName.get(i.name);
    if (prev) finish(i, false, `same name as ${path.basename(prev.file)} — both would record into outputs/${i.name}`);
    else byName.set(i.name, i);
  }
  save();

  const queued = report.items.filter((i) => i.stage === "queued").length;
  say(`batch: ${queued} demo${queued === 1 ? "" : "s"} · ${o.parallel} at a time${o.preset ? ` · preset ${o.preset}` : ""} · ${path.relative(process.cwd(), dir)}`);

  await new Promise<void>((done) => {
    let active = 0;
    const pump = () => {
      while (active < o.parallel) {
        const idx = pickNext(report.items);
        if (idx === -1) break;
        const item = report.items[idx];
        active++;
        void runOne(item, loaded.get(item)!, o, say, save).finally(() => { active--; save(); pump(); });
      }
      if (active === 0) done();
    };
    pump();
  });

  report.finishedAt = new Date().toISOString();
  save();
  return report;
}

async function runOne(item: BatchItem, l: { manifest: Manifest; reference?: Reference }, o: BatchOptions, say: (l: string) => void, save: () => void): Promise<void> {
  const t0 = Date.now();
  item.startedAt = new Date().toISOString();
  const tag = `[${item.name}]`;
  try {
    if (!o.noDry) {
      item.stage = "dry"; save();
      const code = await cli(["dry", item.file], item.log);
      if (code !== 0) return finish(item, false, `dry failed — ${firstLine(item.log, /^✗/) || lastLines(item.log, /fail|error/i) || `exit ${code}`}`, t0, say, tag);
      say(`${tag} dry ✓ ${secs(t0)}`);
    }
    if (o.dryOnly) return finish(item, true, "dry ok", t0, say, tag);

    item.stage = "record"; save();
    say(`${tag} recording…`);
    const args = ["run", item.file, "-o", o.outRoot];
    if (o.preset) args.push("--preset", o.preset);
    if (o.noMaster) args.push("--no-master");
    if (o.brisk) args.push("--brisk");
    const code = await cli(args, item.log);
    const take = readTake(item.outDir);
    if (code !== 0 || !take) {
      const failed = take?.timeline.find((e) => !e.ok);
      return finish(item, false, failed ? `step ${failed.index} failed: ${failed.summary}${failed.error ? ` — ${failed.error.split("\n")[0].slice(0, 140)}` : ""}` : `run exited ${code} — ${lastLines(item.log, /✗|error/i) || "see the log"}`, t0, say, tag);
    }
    const c = check(item.outDir, l.manifest);
    item.check = c.lines.filter((x) => x.startsWith("FAIL"));

    let off: Verdict[] = [];
    if (l.reference) {
      item.stage = "compare"; save();
      const verdicts = compareTake(take, l.manifest, l.reference);
      item.compare = { reference: l.reference.name, verdicts };
      off = verdicts.filter((v) => !v.ok);
    }
    const like = item.compare ? ` · like ${item.compare.reference}: ${item.compare.verdicts.filter((v) => v.ok).length}/${item.compare.verdicts.length}` : "";
    if (!c.ok) return finish(item, false, `check failed — ${item.check[0]?.replace(/^FAIL\s+/, "") ?? "see the log"}`, t0, say, tag);
    finish(item, true, `${(take.duration - take.trimBefore).toFixed(1)}s video${like}${off.length ? ` — ${off[0].line}` : ""}`, t0, say, tag);
  } catch (e) {
    finish(item, false, (e as Error).message.split("\n")[0], t0, say, tag);
  }
}

function finish(item: BatchItem, ok: boolean, result: string, t0?: number, say?: (l: string) => void, tag?: string) {
  item.stage = "done";
  item.ok = ok;
  item.result = result;
  item.finishedAt = new Date().toISOString();
  if (t0) item.seconds = Math.round((Date.now() - t0) / 100) / 10;
  if (say && tag) say(`${tag} ${ok ? "✓" : "✗"} ${result}${t0 ? ` · ${secs(t0)}` : ""}`);
}

/** One CLI stage as a child process, its output appended to the demo's log. */
function cli(args: string[], logFile: string): Promise<number> {
  const { command, args: pre } = entry("cli");
  return new Promise((res) => {
    const out = fs.openSync(logFile, "a");
    fs.writeSync(out, `\n$ retake ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
    const child = spawn(command, [...pre, ...args], { stdio: ["ignore", out, out], env: process.env });
    child.on("error", (e) => { fs.writeSync(out, `✗ ${e.message}\n`); fs.closeSync(out); res(1); });
    child.on("close", (code) => { fs.closeSync(out); res(code ?? 1); });
  });
}

function readTake(outDir: string): Take | null {
  try { return JSON.parse(fs.readFileSync(path.join(outDir, "take.json"), "utf8")) as Take; } catch { return null; }
}

/** The first failure in a log — dry reports every step, and the first one
    that failed is usually the cause of the rest. */
function firstLine(file: string, want: RegExp): string {
  try {
    const hit = fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find((l) => want.test(l));
    return (hit ?? "").replace(/^✗\s*/, "").slice(0, 200);
  } catch { return ""; }
}

/** The most useful line from the end of a log — what a person would scroll to. */
function lastLines(file: string, want: RegExp): string {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const hit = [...lines].reverse().find((l) => want.test(l) && !l.startsWith("$"));
    return (hit ?? "").slice(0, 200);
  } catch { return ""; }
}

const secs = (t0: number) => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

export function renderReport(r: BatchReport): string {
  const done = r.items.filter((i) => i.stage === "done");
  const good = done.filter((i) => i.ok).length;
  const rel = (p: string) => path.relative(path.resolve(r.dir, "../../.."), p) || p;
  const lines = [
    `# Batch ${r.startedAt.replace("T", " ").slice(0, 19)}`,
    "",
    `${good} of ${r.items.length} good · ${r.parallel} at a time${r.preset ? ` · preset ${r.preset}` : ""}${r.finishedAt ? ` · ${((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000).toFixed(0)}s wall clock` : " · still running"}`,
    "",
    "| demo | result | time | video |",
    "|---|---|---:|---|",
    ...r.items.map((i) => `| ${i.name} | ${i.stage !== "done" ? `… ${i.stage}` : i.ok ? `✓ ${esc(i.result ?? "")}` : `✗ ${esc(i.result ?? "")}`} | ${i.seconds !== undefined ? `${i.seconds}s` : ""} | ${i.ok && fs.existsSync(path.join(i.outDir, "demo.mp4")) ? rel(path.join(i.outDir, "demo.mp4")) : ""} |`),
    "",
  ];
  for (const i of r.items) {
    const verdicts = i.compare?.verdicts ?? [];
    if (!i.check?.length && !verdicts.some((v) => !v.ok)) continue;
    lines.push(`## ${i.name}`, "");
    for (const c of i.check ?? []) lines.push(`- ${c}`);
    if (i.compare) {
      lines.push(`- against reference \`${i.compare.reference}\`:`);
      for (const v of verdicts) lines.push(`  - ${v.ok ? "ok" : "**off**"} — ${v.line}`);
    }
    lines.push(`- log: ${path.basename(i.log)} · proof log: ${rel(path.join(i.outDir, "proof-log.md"))}`, "");
  }
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
