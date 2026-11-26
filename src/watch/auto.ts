/**
 * Running journeys without anybody there: every night, and whenever an app
 * has a new version.
 *
 *   retake watch check --scheduled     every 5 minutes: has any app changed?
 *   retake watch run all --scheduled   every night at 03:00
 *
 * Both run through runBatch, so a journey is gated (data-changing journeys
 * only against a test space), recorded and reported the same way whatever
 * started it, and the window can say what started the last run.
 */
import { describeChange } from "./compare.js";
import {
  advance, deployLine, deployNotice, hostOf, journeysByOrigin, lastRunOf, observe as look, readDeploys, takeRunLock,
  writeDeploys, writeLastRun, type Fingerprint, type OriginState, type Trigger,
} from "./deploys.js";
import { failureLine, type RunRecord } from "./journey-store.js";
import { gate, journeyMeta } from "./spaces.js";
import fs from "node:fs";
import path from "node:path";

export type Skipped = { name: string; why: string };

/** Run journeys one after another, saying how each went. */
export async function runBatch(o: {
  root: string; out: string; journeys: { name: string; file: string }[]; trigger: Trigger; host?: string;
  scheduled?: boolean; headed?: boolean; log?: (l: string) => void;
  runner?: (j: { name: string; file: string }) => Promise<RunRecord>;
}): Promise<{ runs: RunRecord[]; skipped: Skipped[] }> {
  const log = o.log ?? (() => {});
  const startedAt = new Date();
  const runs: RunRecord[] = [];
  const skipped: Skipped[] = [];
  const runOne = o.runner ?? (async (j: { name: string; file: string }) => {
    const { runJourney } = await import("./journeys.js");
    return runJourney({ root: o.root, name: j.name, file: j.file, out: o.out, scheduled: o.scheduled, headed: o.headed, log });
  });
  // Journeys that only read go first, so what a data journey makes is not there yet when they look.
  const writes = (j: { file: string }) => { try { return journeyMeta(fs.readFileSync(j.file, "utf8")).changesData; } catch { return false; } };
  const ordered = [...o.journeys.filter((j) => !writes(j)), ...o.journeys.filter((j) => writes(j))];
  for (const j of ordered) {
    const g = gate(o.root, j);
    if (!g.run) { skipped.push({ name: j.name, why: g.why }); log(`– ${j.name} skipped: ${g.why}`); continue; }
    log(`▶ ${j.name}`);
    try {
      const r = await runOne(j);
      runs.push(r);
      const first = r.changes[0];
      if (r.status === "failed") log(`✗ ${j.name} ${failureLine(r)}${r.firstRun ? " (its passing steps are kept as normal)" : ""}`);
      else if (r.status === "changed") log(`△ ${j.name} changed at step ${first.n} (${first.intent}): ${describeChange(first).toLowerCase()}${r.changes.length > 1 ? `, and ${r.changes.length - 1} more step${r.changes.length === 2 ? "" : "s"}` : ""}`);
      else log(`✓ ${j.name} unchanged${r.firstRun ? " — the first run, kept as normal" : ""}${r.adopted ? ` — ${r.adopted} step${r.adopted === 1 ? "" : "s"} passed for the first time and joined the normal` : ""}`);
      log(`  ${path.relative(o.root, r.dir) || r.dir}`);
    } catch (e) {
      log(`✗ ${j.name} could not run — ${(e as Error).message.split("\n")[0]}`);
      let title = j.name;
      try { title = journeyMeta(fs.readFileSync(j.file, "utf8")).title ?? j.name; } catch { /* the name will do */ }
      runs.push({ journey: j.name, title, at: new Date().toISOString(), session: "", dir: "", status: "failed", scheduled: !!o.scheduled, error: (e as Error).message, steps: 0, changes: [] });
    }
  }
  writeLastRun(o.root, lastRunOf(runs, o.trigger, { host: o.host, skipped: skipped.length, at: startedAt }));
  return { runs, skipped };
}

export type CheckResult = { origin: string; host: string; state: OriginState; changed: boolean; runs?: RunRecord[]; skipped?: Skipped[]; notice?: { title: string; body: string } | null };

/**
 * One light check: look at every app the journeys are about, and run an
 * app's journeys when it has a new version (seen twice in a row). Unchanged
 * apps cost one page fetch each and nothing else happens.
 */
export async function checkForDeploys(o: {
  root: string; out: string; scheduled?: boolean;
  log?: (l: string) => void;
  notify?: (title: string, body: string) => void;
  observe?: (entry: string) => Promise<Fingerprint | null>;
  runner?: (j: { name: string; file: string }) => Promise<RunRecord>;
  now?: () => Date;
}): Promise<CheckResult[] | null> {
  const log = o.log ?? (() => {});
  const release = takeRunLock(o.root);
  // A run is already going (last night's, or a deploy's): this check is not needed.
  if (!release) return null;
  try {
    const groups = journeysByOrigin(o.root);
    const all = readDeploys(o.root);
    const results: CheckResult[] = [];
    for (const [origin, journeys] of groups) {
      const declared = journeys.map((j) => { try { return journeyMeta(fs.readFileSync(j.file, "utf8")).url; } catch { return null; } }).find((u) => u && u.startsWith(origin));
      const fp = await (o.observe ?? look)(declared ?? origin);
      const { next, changed } = advance(all[origin], origin, fp, o.now?.());
      all[origin] = next;
      writeDeploys(o.root, all);
      const host = hostOf(origin);
      const res: CheckResult = { origin, host, state: next, changed };
      if (changed) {
        log(`\n═══ ${host} has a new version · ${new Date().toLocaleString()}`);
        const { runs, skipped } = await runBatch({ root: o.root, out: o.out, journeys, trigger: "deploy", host, scheduled: o.scheduled, log, runner: o.runner });
        res.runs = runs; res.skipped = skipped;
        res.notice = deployNotice(host, runs);
        // Silent when nothing changed; the log says so either way.
        if (res.notice) { o.notify?.(res.notice.title, res.notice.body); if (o.scheduled) log(res.notice.body); }
        else log(deployLine(host, runs));
      }
      results.push(res);
    }
    return results;
  } finally { release(); }
}
