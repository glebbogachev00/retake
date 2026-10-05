#!/usr/bin/env node
/**
 * retake — demo-as-code.
 *
 *   retake install                                set up Claude Code / Codex + this folder as the workspace
 *   retake init                                   just the workspace: demos/, outputs/, .env, .gitignore
 *   retake routine                                the house standard — format, captions, voice, music
 *   retake routine run                            work demos/plan.json: stamp, dry, record, finish
 *   retake doctor                                 is everything in place?
 *   retake ui                                     the review window on :4310
 *   retake run demos/x.yaml                       record + render → outputs/x/
 *   retake run demos/x.yaml --headed --no-render  watch the browser, keep only the raw take
 *   retake render outputs/x                       re-render from the existing take (--preset to switch)
 *   retake check outputs/x                        pass/fail on resolution, fps, duration, files
 *   retake verify outputs/x                       did it LOOK right — each scene's `expect`, judged
 *   retake calibrate demos/x.yaml               how much to trust `sweep` — seed defects, count what it finds
 *   retake intent                                 what this product IS — context every visual check needs
 *   retake sweep outputs/x                        look at every frame as a whole — what nobody thought to ask about
 *   retake sense outputs/x                        does the run ADD UP — what went in vs what came out
 *   retake destroy demos/x.yaml                   the flows nobody wrote down — abuse this demo nine ways
 *   retake flag demos/x.yaml --scene s --expect "…"  this one is real: watch it from now on
 *   retake fixed x                                did what you flagged get fixed — with the clip that shows it
 *   retake heal                                  demo files back for recordings whose manifest went missing
 *   retake notes                                  read outputs/ back: what keeps going wrong, and what it costs
 *   retake dry demos/x.yaml                       every selector and wait, no camera
 *   retake validate demos/x.yaml                  schema check only
 *   retake presets                                list quality presets
 *   retake list                                   manifests in ./demos
 *   retake golden add|list|score                  approved visual references and deterministic scorecards
 *   retake describe <name> <url> "<what>"         scout + model → demos/<name>.yaml
 *
 * Run from a clone, the `.ts` source goes through tsx (`npm run retake -- …`);
 * installed from npm, dist/cli.js is the `retake` binary. Same file.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { loadManifest, resolve, warnings, type Manifest } from "./manifest.js";
import { acquireLock, canReuse, captureHash, EXPENSIVE_TAKE_SECONDS, keepPrevious, keptTakes, lastCaptureSeconds, unchangedUpTo, record, releaseLock, restoreKept, restorePrevious, stashPrevious, type Take } from "./record.js";
import { check, contactSheetFile, render } from "./render.js";
import { endProgress, setPhase } from "./progress.js";
import { presetNames } from "./presets.js";
import { applyTidy, mb, planTidy } from "./tidy.js";
import { verify } from "./ext/verify.js";
import { notes } from "./ext/notes.js";
import { sense } from "./ext/sense.js";
import { sweep } from "./ext/sweep.js";
import { TEMPLATE, readIntent, writeIntent } from "./ext/intent.js";
import { planCalibration, report, usable, type Result, type Stability } from "./ext/calibrate.js";
import { checkFlags, flag, unflag } from "./ext/flags.js";
import { describeOrphans, findOrphans, healOrphans } from "./ext/heal.js";
import { SHAPES, describePlan, describeTrials, planDestroy, refuseToRun, tryCandidates } from "./ext/destroy.js";
import { addGolden, assertGoldenApproval, goldenSetStatus, inspectMedia, loadGoldenLedger, scoreGolden, verifyGoldenIntegrity, writeGoldenScorecard, type GoldenRubric } from "./ext/golden.js";
import { PKG_ROOT, VERSION, entry, isDemoFile } from "./paths.js";
import { bringUp, loadEnvSpec, stopEnvironment, verify as verifyEnv } from "./recording-env.js";
import { STYLES, VOICES, RoutineSchema, applyToManifest, environmentFor, compare as compareRoutine, compareToReference, preflightAgainst, learnFrom, measure as measureOutputs, readPlan, describe as describeRoutine, pick as pickRoutine, readRoutines, runRoutine, routineFile, starter, voiceId, writeRoutines, type Routine } from "./routine.js";
import { SECRET_NAME, writeEnvFile } from "./env.js";
import { captureMatchesTake, notePreviewCapture, notePreviewRender, readPreviewReceipt } from "./preview.js";

// The manifest may reference ${VARS}; load .env before any command reads one.
// (`describe` and the UI used to do this individually, so a plain `run` from
// the terminal silently saw empty values — which is how a whole take can fail
// at a login without saying why.)
try {
  const { loadDotenv } = await import("./describe.js");
  loadDotenv(process.cwd());
} catch { /* .env is optional */ }

const program = new Command();
program.name("retake").description("Rerun the demo instead of re-recording it.").version(VERSION);

// `retake notes | head` closes the pipe before the writer is done, and node
// turns that into an unhandled EPIPE and a stack trace. A command-line tool
// should stop quietly when whoever was reading walks away.
process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(0); throw e; });

const say = (l: string) => process.stdout.write(l + "\n");

function parseGoldenRubric(value?: string): GoldenRubric {
  const out: Record<string, string> = {};
  for (const part of (value ?? "").split(",").filter(Boolean)) {
    const [name, rating] = part.split("=").map((item) => item.trim());
    if (name && rating) out[name] = rating;
  }
  const names = ["story", "framing", "timing", "text", "motion"] as const;
  if (names.some((name) => !["pass", "watch", "fail"].includes(out[name]))) {
    throw new Error("--rubric must rate story, framing, timing, text, and motion as pass, watch, or fail");
  }
  return Object.fromEntries(names.map((name) => [name, out[name]])) as GoldenRubric;
}

type GoldenApprovalReceipt = {
  version: 1;
  kind: "retake-human-golden-approval";
  id: string;
  title: string;
  approvedBy: string;
  approvedAt: string;
  sourceContainerSha256: string;
  rubric: GoldenRubric;
};

function readGoldenApprovalReceipt(root: string, file: string, source: string): GoldenApprovalReceipt {
  const approvals = path.join(path.resolve(root), ".approvals");
  const absolute = path.resolve(file);
  const relative = path.relative(approvals, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("approval receipt must come from the golden root's .approvals directory");
  const receipt = JSON.parse(fs.readFileSync(absolute, "utf8")) as GoldenApprovalReceipt;
  if (receipt.version !== 1 || receipt.kind !== "retake-human-golden-approval") throw new Error("unsupported golden approval receipt");
  assertGoldenApproval(receipt);
  if (inspectMedia(source).containerSha256 !== receipt.sourceContainerSha256) throw new Error("approval receipt belongs to different video bytes");
  return receipt;
}


/** Said once, before the camera rolls, when a take is long enough that the
    cheaper ways of getting the same answer are worth knowing about.

    A person who has already spent eight full-quality captures learning the
    shape of a demo has paid for something `--preset draft` would have given
    them in a quarter of the time. The tools existed; nothing said so at the
    moment the cost was being incurred. This is that moment. */
export function costHints(m: Manifest, outDir: string, opts: { preset?: string; until?: string }): string[] {
  const q = resolve(m);
  // Only says a number it has actually seen. A demo nobody has recorded yet
  // gets no estimate, because the honest one does not exist: step count
  // predicts capture time with ~33% error over 31 real takes, and a confident
  // wrong number is worse than none.
  const last = lastCaptureSeconds(outDir);
  if (last === null || last < EXPENSIVE_TAKE_SECONDS) return [];
  const draft = q.name === "draft" || opts.preset === "draft";
  const mins = (n: number) => (n >= 120 ? `${Math.round(n / 60)} min` : `${Math.round(n)}s`);
  const out = [`ℹ the last take of this demo took ${mins(last)} to record.`];
  const ways: string[] = [];
  if (!draft) ways.push("`--preset draft` records the same layout and timing at a quarter of the pixels — use it while the demo is still changing, then run the real preset once");
  if (!opts.until) ways.push("`--until <scene>` stops after one beat, so fixing the ending does not re-record the beginning");
  ways.push("captions, speed, zoom, cards, poster and SIZE are all re-renders — `retake render outputs/" + m.name + " --preset <other>` never needs the camera again");
  for (const w of ways) out.push(`  · ${w}`);
  return out;
}

program
  .command("run")
  .argument("<manifest>", "demo .yaml / .json")
  .option("-o, --out <dir>", "output root", "outputs")
  .option("--headed", "show the browser", false)
  .option("--skip-seed", "do not seed (reuse current app state)", false)
  .option("--no-render", "stop after the raw take")
  .option("--keep-raw", "keep testreel's intermediate files", false)
  .option("--preset <name>", `override the manifest's preset (${presetNames().join(", ")})`)
  .option("--preview", "start the one-capture fast path at preview-fast quality", false)
  .option("--fresh", "discard preview reuse and start a new capture cycle", false)
  .option("--reuse", "reuse the last raw recording if nothing that shapes it changed (re-render only)", false)
  .option("--gif", "also produce a GIF (overrides the manifest)", false)
  .option("--no-master", "skip the archival CRF-14 master — roughly halves render on a long take, and the deliverable is marginally better for it (one encode instead of an encode of an encode)")
  .option("--until <scene>", "record up to the end of this scene, then stop (iterate on one beat without paying for the whole take)")
  .option("--brisk", "record the whole thing without its pacing — every pause skipped, every wait capped. All the steps, none of the holding still: on a long demo that is minutes instead of many. For iterating; record the real one without it.", false)
  .option("--from <scene>", "start the take at this scene — earlier steps still run, at full speed and off camera, so a demo whose ENDING changed stops costing its beginning")
  .option("--name <name>", "write to outputs/<name> instead of the manifest's name — revise a cut without overwriting the published one")
  .action(async (file: string, opts: { out: string; headed: boolean; skipSeed: boolean; render: boolean; keepRaw: boolean; preset?: string; preview: boolean; fresh: boolean; reuse: boolean; gif: boolean; master: boolean; until?: string; from?: string; name?: string; brisk: boolean }) => {
    const loaded = loadManifest(file);
    // Asking for a preset means asking for its SHAPE. A manifest that pins its
    // own `viewport` used to win silently, so `--preset draft` recorded at
    // full size and saved nothing — on the one demo where iterating cheaply
    // mattered most, and with a failing "matches draft" check as the only
    // hint. An explicit --preset now drops the pin.
    let manifest = loaded.manifest;
    if (opts.preview) {
      const { viewport: pinned, ...rest } = loaded.manifest;
      manifest = { ...rest, preset: "preview-fast" };
      if (pinned) say(`ℹ --preview overrides this manifest's viewport (${pinned.width}×${pinned.height})`);
    } else if (opts.preset) {
      const { viewport: pinned, ...rest } = loaded.manifest;
      manifest = { ...rest, preset: opts.preset };
      if (pinned) say(`ℹ --preset ${opts.preset} overrides this manifest's viewport (${pinned.width}×${pinned.height}); recording at the preset's own size`);
    }
    if (opts.gif) manifest = { ...manifest, outputs: { ...manifest.outputs, gif: true } };
    if (opts.preset && !presetNames().includes(opts.preset)) throw new Error(`unknown preset ${opts.preset} — one of ${presetNames().join(", ")}`);
    if (opts.preview && opts.preset && opts.preset !== "preview-fast") throw new Error("--preview cannot be combined with a non-preview preset");
    const dir = loaded.dir;
    if (opts.name && !/^[a-z0-9-]+$/.test(opts.name)) throw new Error("--name must be kebab-case");
    const outDir = path.resolve(opts.out, opts.name ?? manifest.name);
    acquireLock(outDir); // throws if another run owns this folder

    // Reuse: same capture inputs + raw video present → skip the browser.
    // The preview path is stricter: a take is reusable only when its receipt
    // proves it belongs to this one-capture cycle.
    let take: Take | undefined;
    const takePath = path.join(outDir, "take.json");
    const previous = fs.existsSync(takePath)
      ? (() => { try { return JSON.parse(fs.readFileSync(takePath, "utf8")) as Take; } catch { return undefined; } })()
      : undefined;
    const previewReceipt = readPreviewReceipt(outDir);
    const receiptMatches = !!previous
      && previewReceipt?.takeFinishedAt === previous.finishedAt
      && previewReceipt.captureHash === (previous.captureHash ?? null)
      && previewReceipt.rawVideo === previous.video;

    if (!opts.preview && !opts.fresh && previous && receiptMatches && captureMatchesTake(previous, manifest, dir)) {
      releaseLock(outDir);
      throw new Error(`this demo already has a reusable preview capture; final quality must not record again. Run: retake render ${path.relative(process.cwd(), outDir)} ${path.relative(process.cwd(), file)} --final --preset post-landscape --no-master`);
    }
    if (opts.preview && !opts.fresh && previous && receiptMatches && captureMatchesTake(previous, manifest, dir)) {
      if (previewReceipt?.finalizedAt) {
        releaseLock(outDir);
        throw new Error("this preview cycle is already finalized; keep it or pass --fresh to start a genuinely new capture");
      }
      if ((previewReceipt?.renderCount ?? 0) > 0) {
        say(`✓ preview already exists: ${path.relative(process.cwd(), path.join(outDir, "demo.mp4"))}`);
        say(`  1 capture · ${previewReceipt?.renderCount} render${previewReceipt?.renderCount === 1 ? "" : "s"} · ${previewReceipt?.totalSec.toFixed(1)}s total`);
        releaseLock(outDir);
        return;
      }
      take = previous;
    } else if (!opts.fresh && opts.reuse && previous && canReuse(previous, manifest, dir)) {
      take = previous;
    }
    for (const w of warnings(manifest)) say(`⚠ ${w}`);
    if (!take) for (const l of costHints(manifest, outDir, opts)) say(l);
    // Say it while it can still be acted on, not in the summary afterwards.
    if (!take && !opts.until && !opts.from) {
      const u = unchangedUpTo(manifest, outDir);
      const last = lastCaptureSeconds(outDir);
      if (u && u.steps > 3) {
        const share = Math.round((u.steps / manifest.steps.length) * 100);
        say(`ℹ the first ${u.steps} of ${manifest.steps.length} steps are identical to your last take of this demo (${share}% of it).`);
        say(`  · --from ${u.scene} records only what changed${last ? `, so roughly ${Math.max(5, Math.round((last * (100 - share)) / 100))}s instead of ${Math.round(last)}s` : ""}`);
      }
    }
    say(`▶ ${manifest.title ?? manifest.name} → ${path.relative(process.cwd(), outDir)}${take ? " · reusing last recording" : ""}`);
    say(`[stage] capture ${take ? "skip" : "start"}`);

    const t0 = Date.now();
    if (!take) {
      // The previous take is moved aside, not deleted: if this recording dies
      // the person still has the one that worked. See stashPrevious.
      stashPrevious(outDir);
      try {
        take = await record(manifest, { until: opts.until, from: opts.from, brisk: opts.brisk, outDir, headed: opts.headed, skipSeed: opts.skipSeed, manifestDir: dir, log: say, locked: true });
      } catch (e) {
        if (restorePrevious(outDir)) say("↩ recording failed — your previous take has been put back");
        endProgress(outDir);
        releaseLock(outDir);
        throw e;
      }
      keepPrevious(outDir, say);
      if (opts.preview && take.ok && !take.partial && !take.brisk && take.video) {
        notePreviewCapture(outDir, take, take.captureSec ?? (Date.now() - t0) / 1000, "preview-fast");
      }
    }
    say(`■ take done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${take.ok ? "all steps ok" : "SOME STEPS FAILED"} · ${take.video ?? "no video"}`);

    try {
      if (opts.render) {
        say(`[stage] render start`);
        setPhase(outDir, { phase: "rendering", label: "encoding the video" });
        const tr = Date.now();
        const a = await render(manifest, take, outDir, { noMaster: opts.master === false, log: (l) => { if (!l.startsWith("$")) say(l); } });
        const renderSec = (Date.now() - tr) / 1000;
        if (!opts.keepRaw) cleanRaw(outDir, take, a.mp4);
        for (const f of [a.master, a.mp4, a.gif, a.thumbnail, a.proofLog]) if (f) say(`✓ ${path.relative(process.cwd(), f)}`);
        if (a.facts) say(`  ${a.facts.width}×${a.facts.height} @ ${a.facts.fps}fps · ${a.facts.duration.toFixed(1)}s · ${a.facts.encoder} · mp4 ${(a.facts.sizes["demo.mp4"] / 1e6).toFixed(1)} MB${a.gif ? ` · gif ${(a.facts.sizes["demo.gif"] / 1e6).toFixed(1)} MB (${a.facts.gifTool})` : ""} · camera on ${a.facts.cameraScenes} scenes${a.facts.cached ? " · cached" : ""} · render ${renderSec.toFixed(1)}s`);
        const c = check(outDir, manifest);
        say(c.ok ? "check: pass" : "check: FAIL\n  " + c.lines.filter((l) => l.startsWith("FAIL")).join("\n  "));
        if (opts.preview && c.ok) {
          const receipt = notePreviewRender(outDir, take, { preset: "preview-fast", seconds: renderSec, kind: "initial" });
          say(`preview receipt: 1 capture · ${receipt.renderCount} render · ${receipt.totalSec.toFixed(1)}s total · ${receipt.withinTarget ? "within" : "over"} 180s target`);
        }
      }
      setPhase(outDir, { phase: "checking", label: "checking the result" });
      say(`[stage] done`);
    } finally {
      endProgress(outDir);
      releaseLock(outDir);
    }
    if (take.partial) say(`⚠ partial take — ${take.partial}`);
    if (!take.ok || !take.video) process.exitCode = 2;
  });


program
  .command("takes")
  .description("the kept versions of a demo — previous recordings you can go back to")
  .argument("<dir>", "an outputs/<name> dir")
  .action((dir: string) => {
    const kept = keptTakes(path.resolve(dir));
    if (!kept.length) { say(`no kept versions of ${path.basename(dir)} — the current take is the only one.`); return; }
    say(`kept versions of ${path.basename(dir)} (newest first). Only the recording is stored; everything else re-renders.`);
    for (const k of kept) say(`  ${k.id}  ${k.seconds}s · ${k.steps} steps · ${k.mb} MB`);
    say(`\nGo back to one:  retake restore ${path.relative(process.cwd(), dir)} <id>`);
  });

program
  .command("restore")
  .description("make a kept version the current take again, and re-render it")
  .argument("<dir>", "an outputs/<name> dir")
  .argument("<id>", "a version id from `retake takes`")
  .argument("[manifest]", "manifest to render with (default demos/<name>.yaml)")
  .action(async (dir: string, id: string, manifestFile?: string) => {
    const outDir = path.resolve(dir);
    const name = path.basename(outDir);
    acquireLock(outDir);
    try {
      if (!restoreKept(outDir, id)) throw new Error(`no version "${id}" of ${name} — \`retake takes ${path.relative(process.cwd(), outDir)}\` lists them`);
      say(`restored ${id} as the current take`);
      const file = manifestFile ?? path.join("demos", `${name}.yaml`);
      if (!fs.existsSync(file)) { say(`re-render it with:  retake render ${path.relative(process.cwd(), outDir)} <manifest>`); return; }
      const { manifest } = loadManifest(file);
      const take = JSON.parse(fs.readFileSync(path.join(outDir, "take.json"), "utf8")) as Take;
      const a = await render(manifest, take, outDir, { log: (l) => { if (!l.startsWith("$")) say(l); } });
      for (const f of [a.master, a.mp4, a.thumbnail, a.proofLog]) if (f) say(`✓ ${path.relative(process.cwd(), f)}`);
    } finally {
      endProgress(outDir);
      releaseLock(outDir);
    }
  });


program
  .command("tidy")
  .description("reclaim disk from outputs — shows what it would remove; nothing goes without --apply")
  .option("-o, --out <dir>", "output root", "outputs")
  .option("--apply", "actually remove them", false)
  .option("--deep", "also remove demo.mp4 (still re-renderable, but it is the deliverable)", false)
  .option("--orphans", "also remove whole folders whose manifest is gone", false)
  .option("--failed", "also remove the whole folder of any take whose steps failed — raw recording included, and there is no getting it back", false)
  .action((opts: { out: string; apply: boolean; deep: boolean; orphans: boolean; failed: boolean }) => {
    const root = path.resolve(opts.out);
    const plan = planTidy(root, { deep: opts.deep, orphans: opts.orphans, failed: opts.failed, demosDir: path.resolve("demos") });
    if (!plan.bytes) { say(`nothing to reclaim in ${path.relative(process.cwd(), root)} — ${mb(plan.keptBytes)} of recordings and deliverables, all of it worth keeping.`); return; }
    for (const g of plan.groups) {
      say(`${mb(g.bytes).padStart(8)}  ${g.what} — ${g.why}`);
      for (const f of g.files.slice(0, 4)) say(`          ${path.relative(root, f)}`);
      if (g.files.length > 4) say(`          … and ${g.files.length - 4} more`);
    }
    say(`${mb(plan.bytes).padStart(8)}  TOTAL reclaimable · ${mb(plan.keptBytes)} kept (raw recordings and take.json — the only things a re-render cannot rebuild)`);
    if (!opts.apply) {
      say(`\nNothing removed. Run again with --apply.`);
      if (!opts.deep) say(`--deep also drops demo.mp4 · --orphans also drops folders whose manifest is gone`);
      return;
    }
    const freed = applyTidy(plan);
    say(`\nfreed ${mb(freed)}. Every demo can still be rebuilt with \`retake render outputs/<name>\`.`);
  });






program
  .command("flag")
  .description("mark something as really wrong — it becomes an `expect:` on that scene, and every later recording answers it")
  .argument("<manifest>", "the demo it is wrong in")
  .requiredOption("--scene <label>", "which scene shows it")
  .requiredOption("--expect <sentence>", "what has to be true once it is fixed, in plain words")
  .option("--question <sentence>", "what was originally raised, if it came from `sense`")
  .action((file: string, opts: { scene: string; expect: string; question?: string }) => {
    const r = flag(path.resolve(file), { scene: opts.scene, expect: opts.expect, question: opts.question ?? opts.expect, source: opts.question ? "sense" : "you" });
    if ("error" in r) { say(`✗ ${r.error}`); process.exitCode = 2; return; }
    say(`flagged on ${opts.scene}: "${r.flag.expect}"`);
    say(`Every recording from here on answers it — \`verify\` and \`fixed\` both.`);
    say(`\`retake fixed ${path.basename(file).replace(/\.[^.]+$/, "")}\` after the next take.`);
  });


program
  .command("unflag")
  .description("stop watching something you flagged")
  .argument("<manifest>", "the demo it was flagged on")
  .argument("<what>", "the flag's id, or the expectation itself")
  .action((file: string, what: string) => {
    const r = unflag(path.resolve(file), what);
    if ("error" in r) { say(`✗ ${r.error}`); process.exitCode = 2; return; }
    say(`no longer watching: "${r.removed.expect}"`);
  });

program
  .command("fixed")
  .description("did the things you flagged get fixed — answers each one against the newest take, with the few seconds that show it")
  .argument("<demo>", "demo name, or a path to its manifest")
  .option("-o, --out <dir>", "output root", "outputs")
  .option("--no-clips", "skip cutting the clips")
  .action(async (demo: string, opts: { out: string; clips: boolean }) => {
    const file = fs.existsSync(demo) ? path.resolve(demo) : path.resolve("demos", `${demo}.yaml`);
    if (!fs.existsSync(file)) throw new Error(`no ${path.relative(process.cwd(), file)}`);
    const { manifest } = loadManifest(file);
    const outDir = path.resolve(opts.out, manifest.name);
    const r = await checkFlags(file, manifest, outDir, { clips: opts.clips, log: say });
    // Something flagged and still wrong is a failure; nothing flagged is not.
    if (r.checked.some((c) => c.ok !== true)) process.exitCode = 3;
  });

program
  .command("destroy")
  .description("the flows nobody wrote down — writes a manifest for each way this demo could be abused, and tries them")
  .argument("<manifest>", "the demo to derive candidates from")
  .option("-o, --out <dir>", "output root", "outputs")
  .option("--only <shapes>", "just these, comma-separated (see --shapes)")
  .option("--shapes", "list the ways it knows how to break something, and stop", false)
  .option("--run", "actually perform the steps instead of only resolving them — slower, and the only way to catch what happens when an app is really used", false)
  .option("--no-try", "write the candidates and stop")
  .action(async (file: string, opts: { out: string; only?: string; shapes: boolean; run: boolean; try: boolean }) => {
    if (opts.shapes) {
      for (const s of SHAPES) { say(`${s.name}`); say(`  ${s.asks}`); say(`  ${s.because}`); say(""); }
      return;
    }
    const loaded = loadManifest(file);
    const plan = planDestroy(loaded.manifest, path.resolve(opts.out), { only: opts.only?.split(",").map((x) => x.trim()).filter(Boolean) });
    for (const l of describePlan(plan, loaded.manifest)) say(l);
    if (plan.refused) { process.exitCode = 2; return; }
    if (!opts.try || !plan.candidates.length) return;

    // Generating is safe — it makes files. Running clicks things, and that is
    // where the two refusals bite.
    const no = refuseToRun(loaded.manifest, process.env, path.resolve(opts.out));
    if (no) { say(""); say(`✗ not running these: ${no}`); process.exitCode = 2; return; }

    say("");
    const trials = await tryCandidates(plan, { mode: opts.run ? "run" : "dry", manifestDir: loaded.dir, outRoot: path.resolve(opts.out), log: say });
    for (const l of describeTrials(trials, opts.run ? "run" : "dry")) say(l);
    if (trials.some((t) => t.verdict === "broke")) process.exitCode = 3;
  });




program
  .command("calibrate")
  .description("how much to trust `sweep` — seeds a known defect into a working demo, records each one, and counts what it finds")
  .argument("<manifest>", "a demo whose app is running")
  .option("-o, --out <dir>", "output root", "outputs")
  .option("--only <names>", "just these defects, comma-separated")
  .option("--plan", "write the variants and stop", false)
  .action(async (file: string, opts: { out: string; only?: string; plan: boolean }) => {
    const loaded = loadManifest(file);
    const outRoot = path.resolve(opts.out);
    const plan = planCalibration(loaded.manifest, outRoot, { only: opts.only?.split(",").map((x) => x.trim()).filter(Boolean) });
    say(`${plan.variants.length} variants in ${path.relative(process.cwd(), plan.root)}/ — one control, ${plan.variants.length - 1} seeded`);
    if (opts.plan) return;

    const results: Result[] = [];
    /** Sweep once, and give back what it said. */
    const look = async (m: typeof loaded.manifest, dir: string, fresh: boolean) =>
      (await sweep(m, dir, () => {}, { demosDir: path.resolve("demos"), fresh })).frames.flatMap((f) => f.issues.map((i) => i.kind));

    let stability: Stability = null;
    for (const v of plan.variants) {
      const dir = path.join(plan.root, v.name);
      say(`\n${v.name}${v.defect ? ` — ${v.defect.looks}` : ""}`);
      try {
        const take = await record(v.manifest, { outDir: dir, manifestDir: loaded.dir, headed: false, log: () => {} });
        await render(v.manifest, take, dir, { log: () => {}, noMaster: true });
        // A recording that fell over, recorded nothing, or produced no frames
        // measures nothing — whichever end of it broke. Asking sweep about it
        // and reporting the empty answer is how a run against an app that was
        // not even running came back reading "none on the control".
        const fit = usable(dir, take);
        if (!fit.ok) {
          results.push({ variant: v.name, defect: v.defect, kinds: [], found: false, seeded: false, why: fit.why, other: 0 });
          say(`  → not measured: ${fit.why}`);
          continue;
        }
        const kinds = await look(v.manifest, dir, false);
        const found = !v.defect ? false : kinds.some((k) => k.toUpperCase().startsWith(v.defect!.expect.split(" ")[0]));
        results.push({ variant: v.name, defect: v.defect, kinds, found, seeded: true, other: v.defect ? kinds.filter((k) => !k.toUpperCase().startsWith(v.defect!.expect.split(" ")[0])).length : 0 });
        say(`  → ${kinds.join(", ") || "nothing"}`);
        // The control, asked the same question about the same frames a second
        // time. Judges are not deterministic, and a harness that never checks
        // this cannot tell a real finding from a coin landing heads.
        if (!v.defect) {
          say("  asking the control again, to see whether the answer holds");
          stability = { first: kinds, again: await look(v.manifest, dir, true) };
          say(`  → ${stability.again.join(", ") || "nothing"}`);
        }
      } catch (e) {
        const msg = String((e as Error).message).split("\n")[0].slice(0, 90);
        results.push({ variant: v.name, defect: v.defect, kinds: [], found: false, seeded: false, why: `the run threw — ${msg}`, other: 0, error: msg });
        say(`  → could not run: ${msg}`);
      }
    }
    for (const l of report(results, stability)) say(l);
    fs.writeFileSync(path.join(plan.root, "report.json"), JSON.stringify({ at: new Date().toISOString(), demo: loaded.manifest.name, results, stability }, null, 2) + "\n");
    // The false-positive rate is the number people act on. If the control did
    // not record, this run produced no number at all, and exiting 0 says the
    // opposite.
    const control = results.find((r) => !r.defect);
    if (!control?.seeded) { process.exitCode = 3; say("\nnothing was measured — fix the run before quoting any of this."); }
  });

program
  .command("intent")
  .description("what this product IS — the context every visual check is missing without it")
  .argument("[text]", "the note to save; omit to read what is there")
  .option("--demo <name>", "a note for one demo's app, rather than the whole workspace")
  .option("--starter", "write a starter file to fill in", false)
  .action((text: string | undefined, opts: { starter: boolean; demo?: string }) => {
    const demos = path.resolve("demos");
    if (opts.starter || (!text && !readIntent(demos, opts.demo))) {
      if (readIntent(demos, opts.demo) && !text) { say(readIntent(demos, opts.demo)!); return; }
      say(`wrote ${path.relative(process.cwd(), writeIntent(demos, TEMPLATE, opts.demo))} — fill it in.`);
      say("Without it, every check judges your app as a generic web page: anything deliberate about it can come back as a defect.");
      return;
    }
    if (!text) { say(readIntent(demos, opts.demo) ?? ""); return; }
    say(`saved to ${path.relative(process.cwd(), writeIntent(demos, text, opts.demo))}`);
  });

program
  .command("sweep")
  .description("look at every frame as a whole — the ten ways a picture can be wrong, checked on each one, whether or not anybody asked")
  .argument("<dir>", "an outputs/<name> dir")
  .argument("[manifest]", "manifest (default demos/<name>.yaml)")
  .option("--all", "the middle of each scene too, not just its last moment", false)
  .option("--concurrency <n>", "how many frames to look at at once", "4")
  .option("--fresh", "ask about every frame again, even the ones that have not changed", false)
  .action(async (dir: string, manifestFile: string | undefined, opts: { all: boolean; concurrency: string; fresh: boolean }) => {
    const outDir = path.resolve(dir);
    const file = manifestFile ?? path.join("demos", `${path.basename(outDir)}.yaml`);
    if (!fs.existsSync(file)) throw new Error(`no ${file} — pass the manifest path`);
    // No exit code, deliberately. Some of these are judgement; `verify` gates.
    await sweep(loadManifest(file).manifest, outDir, say, { all: opts.all, concurrency: Number(opts.concurrency) || 4, fresh: opts.fresh });
  });

program
  .command("sense")
  .description("does the run ADD UP — what went in against what came out, across the whole demo")
  .argument("<dir>", "an outputs/<name> dir")
  .argument("[manifest]", "manifest (default demos/<name>.yaml)")
  .action((dir: string, manifestFile?: string) => {
    const outDir = path.resolve(dir);
    const file = manifestFile ?? path.join("demos", `${path.basename(outDir)}.yaml`);
    if (!fs.existsSync(file)) throw new Error(`no ${file} — pass the manifest path`);
    // Deliberately no exit code. sense asks questions; `verify` is the gate.
    sense(loadManifest(file).manifest, outDir, say);
  });


program
  .command("heal")
  .description("write back the demo files for recordings whose manifest went missing — the window only lists demos, so those recordings are invisible until it does")
  .option("-o, --out <dir>", "output root", "outputs")
  .option("--apply", "actually write them (without this it only says what it would do)", false)
  .action((opts: { out: string; apply: boolean }) => {
    const orphans = findOrphans(path.resolve(opts.out), path.resolve("demos"));
    const written = opts.apply ? healOrphans(orphans, path.resolve("demos")) : null;
    for (const l of describeOrphans(orphans, written)) say(l);
  });

program
  .command("notes")
  .description("what everyone has actually been doing — reads outputs/ back and says the few things worth saying")
  .option("-o, --out <dir>", "output root", "outputs")
  .option("--all", "every note, not just the five that matter", false)
  .option("--days <n>", "how far back to look", "14")
  .action((opts: { out: string; all: boolean; days: string }) => {
    const { lines } = notes(path.resolve(opts.out), { all: opts.all, days: Number(opts.days) || 14 });
    for (const l of lines) say(l);
  });

program
  .command("verify")
  .description("did it LOOK right — puts each scene's `expect` question to a vision model against that scene's still")
  .argument("<dir>", "an outputs/<name> dir containing take.json and stills/")
  .argument("[manifest]", "manifest to read the expectations from (default demos/<name>.yaml)")
  .action(async (dir: string, manifestFile?: string) => {
    const outDir = path.resolve(dir);
    const file = manifestFile ?? path.join("demos", `${path.basename(outDir)}.yaml`);
    if (!fs.existsSync(file)) throw new Error(`no ${file} — pass the manifest path`);
    const { manifest } = loadManifest(file);
    const v = await verify(manifest, outDir, say, file);
    // 3, the same code dry and check already use for "this did not pass".
    if (!v.ok) process.exitCode = 3;
  });

program
  .command("render")
  .argument("<dir>", "an outputs/<name> dir containing take.json")
  .argument("[manifest]", "manifest to use (default: from take.json's sibling manifest path or demos/<name>.yaml)")
  .option("--preset <name>", "override the manifest's preset for this render")
  .option("--scene <label>", "render just one scene to scene-<label>.mp4 (fast, hardware encode)")
  .option("--gif", "also produce a GIF", false)
  .option("--force", "ignore the render cache", false)
  .option("--final", "finish a one-capture preview cycle from the existing raw take", false)
  .option("--no-master", "skip the archival CRF-14 master — halves render on a long take")
  .option("--with-master", "also create the archival master during a final render", false)
  .option("--out <dir>", "write the render into a NEW directory, leaving the original untouched")
  .action(async (dir: string, manifestFile: string | undefined, opts: { preset?: string; scene?: string; gif: boolean; force: boolean; final: boolean; master: boolean; withMaster: boolean; out?: string }) => {
    if (opts.final && opts.scene) throw new Error("--final cannot render only one scene");
    if (opts.final && opts.out) throw new Error("--final must close the preview cycle in its original output directory");
    const takePath = path.join(dir, "take.json");
    const take = JSON.parse(fs.readFileSync(takePath, "utf8")) as Take;
    // Revising a published cut should not destroy it. Copy the take (and the
    // raw video it points at) into the new directory and render there.
    if (opts.out) {
      const dest = path.resolve(opts.out);
      fs.mkdirSync(dest, { recursive: true });
      for (const f of fs.readdirSync(path.resolve(dir))) {
        if (/^(demo|master)\.mp4$|^demo\.gif$|\.png$|^proof-log\.md$|^facts\.json$|^stills$/.test(f)) continue;
        const from = path.join(path.resolve(dir), f);
        if (fs.statSync(from).isDirectory()) continue;
        fs.copyFileSync(from, path.join(dest, f));
      }
      if (take.video) {
        // The take points at its raw video by absolute path; a copied
        // directory has to point at its own copy or it renders the original.
        const base = path.basename(take.video);
        const copied = path.join(dest, base);
        if (fs.existsSync(copied)) take.video = copied;
        else { fs.copyFileSync(take.video, copied); take.video = copied; }
        fs.writeFileSync(path.join(dest, "take.json"), JSON.stringify(take, null, 2));
      }
      say(`▶ rendering into ${path.relative(process.cwd(), dest)} — ${path.relative(process.cwd(), path.resolve(dir))} is untouched`);
      dir = dest;
    }
    const name = path.basename(path.resolve(dir));
    const mf = manifestFile ?? guessManifest(name);
    const loaded = loadManifest(mf);
    const chosenPreset = opts.preset ?? (opts.final ? "post-landscape" : undefined);
    if (opts.final && chosenPreset !== "post-landscape") throw new Error("--final requires --preset post-landscape");
    let manifest = chosenPreset ? { ...loaded.manifest, preset: chosenPreset } : loaded.manifest;
    if (opts.gif) manifest = { ...manifest, outputs: { ...manifest.outputs, gif: true } };
    acquireLock(path.resolve(dir));
    try {
      if (opts.final && !captureMatchesTake(take, manifest, loaded.dir)) {
        throw new Error("the preview take no longer matches the manifest's capture-relevant steps; record a new preview");
      }
      const before = readPreviewReceipt(path.resolve(dir));
      const receiptMatchesTake = !!before
        && before.takeFinishedAt === take.finishedAt
        && before.captureHash === (take.captureHash ?? null)
        && before.rawVideo === take.video;
      if (opts.final && !receiptMatchesTake) {
        throw new Error("final render requires a current preview capture receipt; run with --preview first");
      }
      if (receiptMatchesTake) {
        if (before.finalizedAt) throw new Error(`preview workflow is already finalized as ${before.finalPreset}; start a fresh preview cycle to change it`);
        if (!before.renders.some((event) => event.kind === "initial")) {
          throw new Error("preview workflow requires its initial preview render before a correction or final");
        }
        if (!opts.final && before.correctionsUsed >= 1) {
          throw new Error("preview correction budget is spent; make the final render or record a fresh preview");
        }
      }
      const renderStart = Date.now();
      const a = await render(manifest, take, path.resolve(dir), {
        log: say,
        force: opts.force,
        scene: opts.scene,
        noMaster: opts.final ? !opts.withMaster : opts.master === false,
      });
      for (const f of [a.master, a.mp4, a.gif, a.thumbnail]) if (f) say(`✓ ${path.relative(process.cwd(), f)}`);
      if (a.facts) say(`  ${Object.entries(a.facts.timings).map(([k, v]) => `${k} ${v}s`).join(" · ")}${a.facts.cached ? " (cached)" : ""}`);
      if (!opts.scene) {
        const result = check(path.resolve(dir), manifest);
        say(result.lines.join("\n"));
        if (opts.final && !result.ok) throw new Error("final render failed check; preview workflow was not finalized");
        if (result.ok && receiptMatchesTake) {
          const kind = opts.final ? "final" : "correction";
          const receipt = notePreviewRender(path.resolve(dir), take, {
            preset: manifest.preset,
            seconds: (Date.now() - renderStart) / 1000,
            kind,
          });
          say(`preview receipt: 1 capture · ${receipt.renderCount} renders · ${receipt.totalSec.toFixed(1)}s total · ${receipt.withinTarget ? "within" : `${receipt.overTargetSec.toFixed(1)}s over`} 180s target${receipt.finalPreset ? ` · final ${receipt.finalPreset}` : ""}`);
        }
      }
    } finally {
      releaseLock(path.resolve(dir));
    }
  });

program
  .command("stitch")
  .description("join existing output dirs (demo.mp4) or video files in order; fit to the first clip's canvas/fps")
  .argument("<inputs...>", "two or more output dirs or video files, in playback order")
  .requiredOption("-o, --out <file>", "new MP4 file; never overwrites an existing file")
  .option("--transition <style>", "cut, fade, dissolve, wipeleft, wiperight, slideleft, slideup, circleopen", "cut")
  .option("--transition-ms <ms>", "overlap per join, 120–1200ms (ignored for cut)", "400")
  .option("--no-audio", "explicitly discard source audio (default: preserve first stream, crossfade with video)")
  .action(async (inputs: string[], opts: { out: string; transition: string; transitionMs: string; audio: boolean }) => {
    const { stitch } = await import("./render.js");
    const file = stitch(inputs, opts.out, { transition: { style: opts.transition, ms: Number(opts.transitionMs) }, audio: opts.audio, log: say });
    say(`✓ ${path.relative(process.cwd(), file)}`);
  });

program
  .command("mcp")
  .description("run Retake as an MCP server, so your own coding agent can drive it")
  .action(async () => {
    // stdio belongs to the protocol from here on; the module talks and exits.
    await import("./operator/tools.js");
  });

/** Files a workspace needs. Never overwrites; says what it did. */
function initWorkspace(root: string, say: (l: string) => void): void {
  const made: string[] = [];
  for (const d of ["demos", "outputs"]) {
    const p = path.join(root, d);
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); made.push(d + "/"); }
  }
  const env = path.join(root, ".env");
  if (!fs.existsSync(env)) { fs.copyFileSync(path.join(PKG_ROOT, ".env.example"), env); made.push(".env"); }
  // Outputs are big and sessions are secrets: keep both out of the user's git.
  const gi = path.join(root, ".gitignore");
  const lines = ["outputs/", ".auth/", ".env", ".drafts/", ".trash/", "ideas/"];
  const have = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  const missing = lines.filter((l) => !have.split(/\r?\n/).some((h) => h.trim() === l || h.trim() === l.replace(/\/$/, "")));
  if (missing.length) {
    fs.writeFileSync(gi, (have ? have.replace(/\n*$/, "\n\n") : "") + "# retake\n" + missing.join("\n") + "\n");
    made.push(`.gitignore (+${missing.length})`);
  }
  say(made.length ? `✓ workspace ${root}: ${made.join(", ")}` : `✓ workspace ${root}: already set up`);
}

function chromiumPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const { chromium } = require("playwright") as typeof import("playwright");
    const p = chromium.executablePath();
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

/** `npx playwright install chromium`, but from wherever playwright actually is. */
function installChromium(say: (l: string) => void): boolean {
  const require = createRequire(import.meta.url);
  let cli: string;
  try { cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js"); } catch { return false; }
  say("… downloading Chromium for Playwright (one time, ~150 MB)");
  const r = spawnSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
  return r.status === 0;
}

/** The MCP server entry, for every config format. */
function mcpServer(ui: string): { command: string; args: string[]; env: Record<string, string> } {
  const tools = entry("operator/tools");
  return { command: tools.command, args: tools.args, env: { RETAKE_ROOT: process.cwd(), RETAKE_UI: ui } };
}
const toml = (server: ReturnType<typeof mcpServer>) => [
  "  [mcp_servers.retake]",
  `  command = ${JSON.stringify(server.command)}`,
  `  args = ${JSON.stringify(server.args)}`,
  `  env = { ${Object.entries(server.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(", ")} }`,
].join("\n");

program
  .command("init")
  .description("make this folder a Retake workspace: demos/, outputs/, .env, .gitignore entries")
  .action(() => initWorkspace(process.cwd(), say));

program
  .command("doctor")
  .description("check that everything Retake needs is in place")
  .action(() => {
    let bad = 0;
    const ok = (l: string) => say(`✓ ${l}`);
    const no = (l: string) => { bad++; say(`✗ ${l}`); };
    const major = Number(process.versions.node.split(".")[0]);
    (major >= 20 ? ok : no)(`node ${process.versions.node}${major < 20 ? " — Retake needs 20 or newer" : ""}`);
    const chrome = chromiumPath();
    chrome ? ok(`chromium ${chrome}`) : no("chromium not downloaded — run: retake install  (or: npx playwright install chromium)");
    try {
      const require = createRequire(import.meta.url);
      const ff = require("ffmpeg-static") as string;
      fs.existsSync(ff) ? ok(`ffmpeg ${ff}`) : no("ffmpeg-static is missing its binary — reinstall retake-demos");
    } catch { no("ffmpeg-static not found — reinstall retake-demos"); }
    const which = (bin: string) => spawnSync("which", [bin], { encoding: "utf8" }).stdout.trim();
    say(which("gifski") ? `✓ gifski (better GIFs)` : `· gifski not installed — GIFs fall back to ffmpeg (brew install gifski)`);
    say(which("claude") ? `✓ claude CLI — \`retake install\` can register the tools` : `· claude CLI not found — paste the config from \`retake agent\` into your agent`);
    say(which("codex") ? `✓ codex CLI` : `· codex CLI not found (fine if you don't use Codex)`);
    const root = process.cwd();
    fs.existsSync(path.join(root, "demos")) ? ok(`workspace ${root}`) : say(`· ${root} is not a workspace yet — run: retake init`);
    if (bad) process.exitCode = 1;
  });

program
  .command("install")
  .description("set up this folder as the workspace, download Chromium, register the tools with Claude Code (and print the Codex config)")
  .option("--ui <url>", "the Retake window agents report into", "http://localhost:4310")
  .action(async (o: { ui: string }) => {
    const os = await import("node:os");
    const { execFileSync } = await import("node:child_process");
    // 1. the workspace: demos/ and outputs/ live where the command was run
    initWorkspace(process.cwd(), say);
    // 2. the browser
    if (chromiumPath()) say("✓ chromium present");
    else if (!installChromium(say)) say("✗ could not download Chromium — run `npx playwright install chromium` and try again");
    // 3. the tools, registered with Claude Code for every project
    const server = mcpServer(o.ui);
    try {
      execFileSync("claude", ["mcp", "add-json", "retake", JSON.stringify(server), "--scope", "user"], { stdio: "pipe" });
      say("✓ Claude Code: retake tools registered (user scope)");
    } catch {
      say("✗ Claude Code CLI not found or refused — run `retake agent` and paste the config yourself");
    }
    // 4. the skill: when to reach for the tools, and in what order
    const skillSrc = path.join(PKG_ROOT, "skill", "SKILL.md");
    const skillDst = path.join(os.homedir(), ".claude", "skills", "recording-product-demos");
    if (fs.existsSync(skillSrc)) {
      fs.mkdirSync(skillDst, { recursive: true });
      fs.copyFileSync(skillSrc, path.join(skillDst, "SKILL.md"));
      say("✓ Claude Code: recording-product-demos skill installed");
    }
    say("");
    say("Codex — add to ~/.codex/config.toml (Codex has no skill store; the tool descriptions carry the method):");
    say(toml(server));
    say("");
    say("One thing only you can do: RESTART Claude Code / Codex — they load new tools at the start of a session, not mid-way.");
    say("Then, in any project: “record a demo of my app showing the sign-up flow”.");
    say(`Start the window with \`retake ui\` and keep ${o.ui} open to watch. Starting your app from an agent needs RETAKE_ALLOW_START=1 in the env above.`);
  });

program
  .command("agent")
  .description("print the config to paste into Claude Code, Codex, or Cursor")
  .option("--ui <url>", "the Retake window to report into", "http://localhost:4310")
  .action((o: { ui: string }) => {
    // RETAKE_UI is what makes the app a window onto the work rather than a
    // folder you check afterwards: the tools report progress there as they go.
    const server = mcpServer(o.ui);
    const cfg = { mcpServers: { retake: server } };
    say("Add Retake to your agent, then ask it for a demo in plain English.\n");
    say("Claude Code — run this once:");
    say(`  claude mcp add-json retake '${JSON.stringify(server)}'\n`);
    say("Codex — add to ~/.codex/config.toml:");
    say(toml(server) + "\n");
    say("Cursor / anything else that speaks MCP — .cursor/mcp.json or equivalent:");
    say(JSON.stringify(cfg, null, 2) + "\n");
    say("Then just say: “record a demo of my app at localhost:3000 showing the sign-up flow”.");
    say(`Keep ${o.ui} open while it works — the plan, the run and the video appear there.`);
    say("Retake will not start your app from outside its own window unless you add RETAKE_ALLOW_START=1 above.");
  });

/** Read one line from stdin. On a terminal, `hide` switches to raw mode so the
    characters are not echoed; on a pipe, lines are simply consumed in order. */
let stdinBuf = "";
function promptLine(label: string, hide: boolean): Promise<string> {
  process.stdout.write(label);
  const tty = !!process.stdin.isTTY;
  const raw = hide && tty;
  if (raw) process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    const finish = (line: string) => {
      process.stdin.off("data", onData);
      if (raw) process.stdin.setRawMode(false);
      process.stdin.pause();
      if (raw) process.stdout.write("\n");
      resolve(line.trim());
    };
    const take = () => {
      const i = stdinBuf.search(/\r|\n/);
      if (i < 0) return false;
      const line = stdinBuf.slice(0, i);
      stdinBuf = stdinBuf.slice(i + 1).replace(/^\n/, "");
      finish(line);
      return true;
    };
    const onData = (d: Buffer) => {
      const sIn = d.toString();
      if (raw) {
        for (const ch of sIn) {
          if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
          if (ch === "\u007f" || ch === "\b") { stdinBuf = stdinBuf.slice(0, -1); continue; }
          stdinBuf += ch;
        }
      } else stdinBuf += sIn;
      take();
    };
    if (take()) return;
    process.stdin.on("data", onData);
  });
}

program
  .command("secret")
  .description("put a demo account into this workspace's .env without opening the file — typed here, hidden, kept on this machine only")
  .argument("<names...>", "variable names, e.g. APP_USER APP_PASSWORD APP_TOTP_SECRET")
  .action(async (names: string[]) => {
    const bad = names.filter((n) => !SECRET_NAME.test(n));
    if (bad.length) throw new Error(`names look like APP_PASSWORD — not: ${bad.join(", ")}`);
    say(`Stays on this computer: written to ${path.join(process.cwd(), ".env")} (readable by you only), never sent anywhere, never shown to an agent. Use a demo account.`);
    const values: Record<string, string> = {};
    for (const n of names) {
      const v = await promptLine(`${n}${/PASS|SECRET|TOKEN|KEY|PIN|OTP/.test(n) ? " (hidden)" : ""}: `, /PASS|SECRET|TOKEN|KEY|PIN|OTP/.test(n));
      if (v) values[n] = v;
    }
    const set = writeEnvFile(process.cwd(), values);
    if (!set.length) { say("nothing saved"); return; }
    say(`✓ ${set.join(", ")} saved to ${path.join(process.cwd(), ".env")} (mode 600). A manifest references them as \${NAME} with secret: true — the values never go on camera.`);
  });

program
  .command("signin")
  .description("sign in by hand once — 2FA, SSO, captcha, anything — and keep the session for every later take")
  .argument("<manifest>", "the demo whose auth.storageState should be saved")
  .action(async (file: string) => {
    const { manifest, dir } = loadManifest(file);
    if (!manifest.auth?.storageState) throw new Error(`${file} has no auth.storageState — add:\n  auth:\n    storageState: .auth/${manifest.name}.json\n    maxAgeHours: 24`);
    const { resolve, expandEnv } = await import("./manifest.js");
    const { chromium } = await import("playwright");
    const q = resolve(manifest);
    const statePath = path.resolve(dir, expandEnv(manifest.auth.storageState));
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: q.viewport });
    const page = await context.newPage();
    await page.goto(manifest.url, { waitUntil: "domcontentloaded" }).catch(() => {});
    say(`A browser is open at ${manifest.url}.`);
    say(`Sign in there — codes, SSO, captcha, whatever it asks. When you can see the signed-in app, come back here and press Enter.`);
    say(`(Nothing is recorded. Only the session is kept, in ${path.relative(process.cwd(), statePath)}, good for ${manifest.auth.maxAgeHours}h.)`);
    await new Promise<void>((ok) => { process.stdin.resume(); process.stdin.once("data", () => ok()); });
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      await context.storageState({ path: statePath });
      fs.chmodSync(statePath, 0o600);
    } catch (e) {
      // Closing the window instead of pressing Enter is the usual way here:
      // say so plainly rather than showing a stack, and leave no orphan.
      const why = page.isClosed() ? "the browser window was closed before the session could be saved" : String((e as Error).message ?? e);
      throw new Error(`Could not save the session — ${why}.\nRun \`retake signin ${file}\` again, and this time leave the window open and press Enter here.`);
    } finally {
      await browser.close().catch(() => {});
    }
    say(`✓ session saved → ${path.relative(process.cwd(), statePath)}. Takes of ${manifest.name} now start signed in; run this again when it goes stale.`);
    process.exit(0);
  });

program
  .command("dry")
  .description("run the manifest with no camera and report what would fail")
  .argument("<manifest>")
  .option("--no-seed", "do not run seeds first (by default dry seeds, so it sees the state run will see)")
  .action(async (file: string, opts: { seed: boolean }) => {
    const { manifest, dir } = loadManifest(file);
    const { dryRun } = await import("./dryrun.js");
    const r = await dryRun(manifest, dir, say, { seed: opts.seed });
    if (!r.ok) process.exitCode = 3;
  });

program
  .command("check")
  .argument("<dir>", "an outputs/<name> dir")
  .description("verify the artifacts are post-worthy: resolution, fps, duration, files, pass/fail")
  .action((dir: string) => {
    const name = path.basename(path.resolve(dir));
    let manifest;
    try { manifest = loadManifest(guessManifest(name)).manifest; } catch { /* optional */ }
    const c = check(path.resolve(dir), manifest);
    say(c.lines.join("\n"));
    say(c.ok ? "check: pass" : "check: FAIL");
    if (!c.ok) process.exitCode = 3;
  });

program
  .command("ideas")
  .description("scan an app (and its source) and propose demos worth recording")
  .argument("<url>")
  .option("-P, --project <dir>", "also read the app's source")
  .option("-o, --out <file>", "where to write the markdown (default ideas/<host>.md)")
  .action(async (url: string, opts: { project?: string; out?: string }) => {
    const { loadDotenv, pickProvider, scout, suggestIdeas } = await import("./describe.js");
    loadDotenv(process.cwd());
    const provider = pickProvider();
    if (!provider) throw new Error("no model configured — set one in the UI's Settings, or RETAKE_MODEL in .env");
    say(`scouting ${url} …`);
    const sc = await scout(url);
    say(`drafting ideas with ${provider.name} (${provider.model}) …`);
    const { markdown, ideas } = await suggestIdeas({ url, scout: sc, provider, project: opts.project });
    const file = path.resolve(opts.out ?? path.join("ideas", `${new URL(url).host.replace(/[^a-z0-9]+/gi, "-")}.md`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# Demo ideas — ${url}\n\n_Suggested by ${provider.name} (${provider.model})${opts.project ? ` after reading ${opts.project}` : ""}._\n\n${markdown}\n`);
    for (const i of ideas) say(`· ${i.title}${i.length ? ` (${i.length})` : ""}`);
    say(`✓ ${path.relative(process.cwd(), file)}`);
  });

program
  .command("contact")
  .argument("<dir>", "an outputs/<name> dir")
  .option("--every <seconds>", "seconds between frames", "2")
  .option("-w, --width <px>", "width of each cell", "420")
  .description("one timestamped contact sheet of the finished video — the artifact for signing a cut off")
  .action(async (dir: string, opts: { every: string; width: string }) => {
    const { contactSheet } = await import("./render.js");
    const out = contactSheet(path.resolve(dir), Number(opts.every), Number(opts.width), say);
    say(`✓ ${path.relative(process.cwd(), out)}`);
  });

program
  .command("golden")
  .argument("<action>", "approve, add, list, verify, or score")
  .argument("[target]", "source MP4 for approve/add; candidate MP4 for score")
  .option("--root <dir>", "approved reference directory", "goldens")
  .option("--id <id>", "reference family id for approval")
  .option("--title <title>", "human-readable reference title")
  .option("--variant <name>", "voice or delivery variant label")
  .option("--approved-by <name>", "person approving this finished video")
  .option("--rubric <ratings>", "story=pass,framing=pass,timing=pass,text=pass,motion=pass")
  .option("--approval-receipt <file>", "interactive human approval receipt for add")
  .option("--against <id>", "reference family to score against")
  .description("human-approved visual references: approve interactively, store evidence, verify readiness, or score media facts")
  .action(async (action: string, target: string | undefined, opts: { root: string; id?: string; title?: string; variant?: string; approvedBy?: string; rubric?: string; approvalReceipt?: string; against?: string }) => {
    const root = path.resolve(opts.root);
    if (action === "approve") {
      if (!target || !opts.id || !opts.title || !opts.approvedBy || !opts.rubric) throw new Error("golden approve requires <mp4>, --id, --title, --approved-by, and --rubric");
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("golden approval requires an interactive human terminal");
      const source = path.resolve(target);
      const rubric = parseGoldenRubric(opts.rubric);
      assertGoldenApproval({ id: opts.id, title: opts.title, approvedBy: opts.approvedBy, rubric });
      const media = inspectMedia(source);
      say(`Review: ${path.basename(source)} · ${media.width}×${media.height} · ${media.duration.toFixed(2)}s`);
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question(`Type APPROVE ${opts.id} to issue a one-use receipt: `);
      prompt.close();
      if (answer.trim() !== `APPROVE ${opts.id}`) throw new Error("approval cancelled");
      const receipt: GoldenApprovalReceipt = {
        version: 1,
        kind: "retake-human-golden-approval",
        id: opts.id,
        title: opts.title.trim(),
        approvedBy: opts.approvedBy.trim(),
        approvedAt: new Date().toISOString(),
        sourceContainerSha256: media.containerSha256,
        rubric,
      };
      const approvals = path.join(root, ".approvals");
      fs.mkdirSync(approvals, { recursive: true });
      const file = path.join(approvals, `${receipt.id}-${receipt.sourceContainerSha256.slice(0, 12)}.json`);
      fs.writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      say(`✓ approval receipt: ${path.relative(process.cwd(), file)}`);
      return;
    }
    if (action === "add") {
      if (!target || !opts.approvalReceipt) throw new Error("golden add requires <mp4> and --approval-receipt from an interactive golden approve");
      const source = path.resolve(target);
      const receiptFile = path.resolve(opts.approvalReceipt);
      const receipt = readGoldenApprovalReceipt(root, receiptFile, source);
      const existing = loadGoldenLedger(root).references.find((reference) => reference.id === receipt.id);
      let pending: string | undefined;
      let contact: string | undefined;
      try {
        if (!existing) {
          fs.mkdirSync(root, { recursive: true });
          pending = fs.mkdtempSync(path.join(root, ".pending-"));
          contact = path.join(pending, "contact.png");
          contactSheetFile(source, contact, 2, 420, say);
        }
        const reference = addGolden(root, source, { id: receipt.id, title: receipt.title, approvedBy: receipt.approvedBy, approvedAt: receipt.approvedAt, rubric: receipt.rubric, variant: opts.variant, contact });
        fs.rmSync(receiptFile, { force: true });
        say(`✓ ${reference.id}: ${reference.variants.length} variant${reference.variants.length === 1 ? "" : "s"} · approved by ${reference.approvedBy}`);
        say(`  ledger: ${path.relative(process.cwd(), path.join(root, "index.json"))}`);
      } finally {
        if (pending) fs.rmSync(pending, { recursive: true, force: true });
      }
      return;
    }
    if (action === "list" || action === "verify") {
      const ledger = loadGoldenLedger(root);
      const integrity = verifyGoldenIntegrity(root);
      for (const reference of ledger.references) say(`${reference.id.padEnd(32)} ${reference.variants.length} variant${reference.variants.length === 1 ? " " : "s"} · ${reference.title} · ${reference.approvedBy}`);
      if (!ledger.references.length) say("no approved references");
      for (const line of integrity.lines.filter((line) => line.startsWith("FAIL"))) say(line);
      const status = goldenSetStatus(root);
      say(`${status.complete && integrity.ok ? "pass" : "INCOMPLETE"}  ${status.message}`);
      if (!integrity.ok || (action === "verify" && !status.complete)) process.exitCode = 3;
      return;
    }
    if (action === "score") {
      if (!target || !opts.against) throw new Error("golden score requires <candidate.mp4> and --against <id>");
      const score = scoreGolden(root, path.resolve(target), opts.against);
      const scorecard = writeGoldenScorecard(root, score);
      for (const row of score.rows) say(`${row.status.padEnd(4)}  ${row.name}: ${row.actual}${row.status === "fail" ? ` (expected ${row.expected})` : ""}`);
      say(score.ok ? "scorecard: pass" : "scorecard: FAIL");
      say(`  ${path.relative(process.cwd(), scorecard)}`);
      if (!score.ok) process.exitCode = 3;
      return;
    }
    throw new Error(`unknown golden action ${action} — use approve, add, list, verify, or score`);
  });

program
  .command("gif")
  .argument("<dir>", "an outputs/<name> dir")
  .option("-w, --width <px>", "width", "900")
  .option("-f, --fps <n>", "frames per second", "18")
  .description("make a GIF from the finished demo.mp4 (gifski when installed)")
  .action(async (dir: string, opts: { width: string; fps: string }) => {
    const { makeGif } = await import("./render.js");
    const out = makeGif(path.resolve(dir), Number(opts.width), Number(opts.fps), say);
    say(`✓ ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
  });

program
  .command("presets")
  .description("list quality presets")
  .action(async () => {
    const { PRESETS } = await import("./presets.js");
    const { bandHeightFor } = await import("./captions.js");
    say(`${"preset".padEnd(16)} ${"video".padEnd(12)} ${"page".padEnd(11)} fps  layout`);
    for (const p of Object.values(PRESETS)) {
      const band = p.layout === "band" || p.layout === "card" ? p.bandHeight : 0;
      const page = `${p.width}×${p.height - band}`;
      say(`${p.name.padEnd(16)} ${String(p.width + "×" + p.height).padEnd(12)} ${page.padEnd(11)} ${String(p.fps).padEnd(4)} ${p.layout.padEnd(5)} — ${p.description}`);
    }
    say(`\nOne preset, one size: the caption band sits inside the canvas, so every take at a preset comes out identical and no player letterboxes it. A manifest's \`viewport\` overrides the page (validate warns). \`captions: false\` → the page fills the frame.`);
  });

program
  .command("validate")
  .argument("<manifest>")
  .action(async (file: string) => {
    const { manifest } = loadManifest(file);
    const { resolve } = await import("./manifest.js");
    const q = resolve(manifest);
    // The video is the page area plus the caption band, so say the real number
    // here rather than letting it surprise someone after a two-minute take.
    const { bandHeightFor } = await import("./captions.js");
    const outW = q.layout === "card" ? q.width : q.viewport.width;
    const band = bandHeightFor(q, manifest.steps.flatMap((s) => (s.action === "scene" && s.caption ? [s.caption] : [])));
    const outH = (q.layout === "card" ? q.height : q.viewport.height) + (q.layout === "band" ? band : 0);
    say(`ok: ${manifest.name} · ${manifest.steps.length} steps · ${manifest.steps.filter((s) => s.action === "scene").length} scenes`);
    say(`   ${q.name} · video ${outW}×${outH}${q.layout === "band" ? (band ? ` (page ${q.viewport.width}×${q.viewport.height} + a ${band}px caption band)` : " (captions off — the page fills the frame)") : ""} @ ${q.fps}fps${q.gif ? ` · gif ${q.gif.width}px` : ""}`);
    for (const w of warnings(manifest)) say(`⚠ ${w}`);
  });

program
  .command("describe")
  .description("scout a URL and let a model draft the manifest")
  .argument("<name>", "kebab-case demo name")
  .argument("<url>")
  .argument("<what>", "one sentence: what to record")
  .option("-P, --project <dir>", "also read the app's source: routes, sign-in, real selectors, flaky bits")
  .action(async (name: string, url: string, what: string, opts: { project?: string }) => {
    const { draftManifest, loadDotenv, pickProvider, scout } = await import("./describe.js");
    loadDotenv(process.cwd());
    const provider = pickProvider();
    if (!provider) throw new Error("no model configured — set GROQ_API_KEY, MISTRAL_API_KEY, or RETAKE_LOCAL_URL");
    say(`scouting ${url} …`);
    const sc = await scout(url);
    if (opts.project) {
      const { digest } = await import("./digest.js");
      const dg = digest(opts.project);
      say(`read ${dg.files} files in ${dg.name}: ${dg.routes.length} routes, ${dg.selectors.length} selectors, ${dg.flaky.length} risks`);
    }
    say(`found ${sc.elements.length} interactive elements · drafting with ${provider.name} (${provider.model}) …`);
    const d = await draftManifest({ name, url, describe: what, scout: sc, provider, project: opts.project, demosDir: path.join(process.cwd(), "demos") });
    const file = path.resolve("demos", `${name}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, d.yaml);
    say(`✓ ${path.relative(process.cwd(), file)}${d.retried ? " (after one retry)" : ""} — read it, then: retake run ${path.relative(process.cwd(), file)}`);
  });

program
  .command("ui")
  .option("-p, --port <port>", "port", "4310")
  .action(async (opts: { port: string }) => {
    const { serve } = await import("./ui/server.js");
    serve(Number(opts.port));
  });

program.command("list").action(() => {
  const dir = path.resolve("demos");
  for (const f of fs.readdirSync(dir).filter((f) => /\.(ya?ml|json)$/.test(f))) {
    try {
      const { manifest } = loadManifest(path.join(dir, f));
      say(`${f.padEnd(28)} ${manifest.title ?? ""}`);
    } catch (e) {
      say(`${f.padEnd(28)} ✗ ${(e as Error).message.split("\n")[0]}`);
    }
  }
});

function guessManifest(name: string): string {
  for (const ext of ["yaml", "yml", "json"]) {
    const p = path.resolve("demos", `${name}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`no demos/${name}.yaml found — pass the manifest path`);
}

/** Drop playwright's raw .webm and testreel debug files. The raw take mp4
    (take.video) stays — `retake render` re-renders from it. */
function cleanRaw(outDir: string, take: Take, finalMp4?: string) {
  for (const f of fs.readdirSync(outDir)) {
    const p = path.join(outDir, f);
    if (p === finalMp4 || (take.video && path.resolve(take.video) === p)) continue;
    if (/cursor.*\.json$/.test(f) || /^debug-filter\.txt$/.test(f) || /-final\.png$/.test(f)) fs.rmSync(p, { force: true });
  }
}

/* ───────────────────────── routines ─────────────────────────────────────────
   The settings nobody should be asked about twice. `style.md` is taste a model
   reads; a routine is data the machine stamps. Everything here exists so that
   "record these five" comes back five times the same. */

const DEMOS_DIR = () => path.resolve("demos");

/* ───────────────────────── the recording environment ────────────────────────
   Six takes in one session were lost to the environment, not the recorder.
   Declaring it is cheap; discovering it from a frame is not. */

/** The environment to use: the one named, else the routine in use's own,
    else the workspace's demos/environment.yaml. */
function envFile(named?: string): string {
  if (named) return path.resolve(named);
  const file = readRoutines(DEMOS_DIR());
  const found = environmentFor(DEMOS_DIR(), file ? file.routines[file.use] : undefined);
  if (!found) throw new Error("no environment declared — `retake routine setup <app-url>` drafts one, or write demos/environment.yaml");
  return found;
}

const env = program
  .command("env")
  .description("the app under test: bring it up isolated, reset it, and PROVE it before recording");

env
  .command("up", { isDefault: true })
  .option("-f, --file <path>", "environment file (default: the routine's, else demos/environment.yaml)")
  .option("--no-verify", "skip the proof (you will find out from a frame instead)")
  .description("start it clean and check it is what it claims")
  .action(async (opts: { file?: string; verify: boolean }) => {
    const spec = loadEnvSpec(envFile(opts.file));
    say(`environment ${spec.name}`);
    const up = await bringUp(spec, say);
    say(`  up at ${up.url}${up.restarted ? " (restarted)" : ""}`);
    if (!opts.verify) { say("  not verified — you asked."); return; }
    const v = await verifyEnv(spec, say);
    if (!v.ok) { say(`\n✗ the environment is not what it claims. Recording now would cost a take to learn this.`); process.exitCode = 2; return; }
    say(`\n✓ ready — ${spec.name} is isolated, reset, and proven.`);
  });

env
  .command("check")
  .option("-f, --file <path>", "environment file (default: the routine's, else demos/environment.yaml)")
  .description("prove the running app without restarting it")
  .action(async (opts: { file?: string }) => {
    const spec = loadEnvSpec(envFile(opts.file));
    say(`environment ${spec.name}`);
    const v = await verifyEnv(spec, say);
    if (!v.ok) process.exitCode = 2;
    else say(`\n✓ proven.`);
  });

env
  .command("down")
  .option("-f, --file <path>", "environment file (default: the routine's, else demos/environment.yaml)")
  .description("stop it")
  .action((opts: { file?: string }) => {
    const spec = loadEnvSpec(envFile(opts.file));
    stopEnvironment(spec, say);
    say("stopped.");
  });




/* A routine is the standing answer; these are the one-off exceptions to it —
   "this batch in Andrew, everything else as usual". They never touch
   demos/routine.json, so the standard cannot drift by being borrowed. */
function overrideRoutine(r: Routine, o: { voice?: string; style?: string; rate?: string; captions?: string }): { routine: Routine; said: string[] } {
  const patch: Record<string, unknown> = {};
  const said: string[] = [];
  if (o.style) {
    if (!(o.style in STYLES)) throw new Error(`--style is one of ${Object.keys(STYLES).join(", ")}`);
    patch.style = o.style; said.push(`style ${o.style}`);
  }
  if (o.voice) { patch.voice = o.voice; said.push(`voice ${o.voice === "silent" ? "silent" : voiceId(o.voice)}`); }
  if (o.rate !== undefined) {
    if (!/^-?\d+$/.test(o.rate)) throw new Error("--rate is a whole percent, -50 to 50");
    patch.rate = Number(o.rate); said.push(`rate ${Number(o.rate) >= 0 ? "+" : ""}${Number(o.rate)}%`);
  }
  if (o.captions) {
    if (!/^(on|off|true|false)$/i.test(o.captions)) throw new Error("--captions is on or off");
    patch.captions = /^(on|true)$/i.test(o.captions); said.push(`captions ${patch.captions ? "on" : "off"}`);
  }
  if (!said.length) return { routine: r, said };
  const parsed = RoutineSchema.safeParse({ ...r, ...patch });
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return { routine: parsed.data, said };
}

const routine = program
  .command("routine")
  .description("the house standard — format, captions, voice, music — applied to every demo this workspace records");

routine
  .command("show", { isDefault: true })
  .argument("[name]", "which routine (default: the one in use)")
  .description("what every recording will look and sound like")
  .action((name?: string) => {
    const file = readRoutines(DEMOS_DIR());
    if (!file) { say("no routine yet.\n\n  retake routine init    write the house standard\n"); return; }
    const which = name ?? file.use;
    const r = file.routines[which];
    if (!r) throw new Error(`no routine called "${which}" — have: ${Object.keys(file.routines).join(", ")}`);
    say(describeRoutine(which, r));
    const others = Object.keys(file.routines).filter((n) => n !== which);
    if (others.length) say(`\n  also here: ${others.join(", ")} — \`retake routine use <name>\` to switch.`);
  });

routine
  .command("setup")
  .argument("<app-url>", "where the product runs — your local dev URL, or a live site")
  .option("--like <video>", "one video you love: the cards, colours and shape every recording will match")
  .option("--as <name>", "the routine's name (default: the project's)")
  .option("--dir <project>", "the project folder, when the app is not running yet")
  .description("a new product in one step: an isolated app, a north star, branded cards, a brief")
  .action(async (url: string, opts: { like?: string; as?: string; dir?: string }) => {
    const { setupProduct } = await import("./setup.js");
    say(`setting up ${url}${opts.like ? ` to look like ${path.basename(opts.like)}` : ""}\n`);
    const { name, routine: r, wrote, next } = await setupProduct({ url, like: opts.like, name: opts.as, dir: opts.dir, demosDir: DEMOS_DIR(), log: say });
    say(`\n${describeRoutine(name, r)}`);
    say(`\nwrote ${wrote.join(", ")}`);
    if (next.length) {
      say(`\nstill yours to decide:`);
      for (const n of next) say(`  · ${n}`);
    }
    say(`\nnext: write the first demo — an agent calls the \`routine\` tool and reads the brief first.`);
  });

routine
  .command("init")
  .description("write demos/routine.json with the house standard: showcase, captions on, silent")
  .action(() => {
    const f = routineFile(DEMOS_DIR());
    if (fs.existsSync(f)) throw new Error(`${path.relative(process.cwd(), f)} already exists — \`retake routine set\` changes it`);
    const data = starter();
    writeRoutines(DEMOS_DIR(), data);
    say(`✓ ${path.relative(process.cwd(), f)}\n`);
    say(describeRoutine("default", data.routines.default));
    say(`\n  Silent on purpose: the first video should exist before anyone is asked`);
    say(`  about narration. \`retake routine voices\` when you want one.`);
  });

routine
  .command("learn")
  .argument("[manifests...]", "default: every manifest in demos/")
  .option("--as <name>", "write it to this routine (default: the one in use)")
  .option("--write", "save it; without this it only shows you what it found", false)
  .description("read the standard off demos you have already recorded, instead of taking Retake's defaults")
  .action((files: string[], opts: { as?: string; write: boolean }) => {
    const targets = files.length
      ? files.map((f) => path.resolve(f))
      : fs.readdirSync(DEMOS_DIR()).filter(isDemoFile).map((f) => path.join(DEMOS_DIR(), f));
    const { routine: learned, from, notes } = learnFrom(targets);
    say(`read ${from.length} manifest${from.length === 1 ? "" : "s"}: ${from.slice(0, 6).join(", ")}${from.length > 6 ? `, +${from.length - 6} more` : ""}\n`);
    const file = readRoutines(DEMOS_DIR());
    const name = opts.as ?? file?.use ?? "default";
    say(describeRoutine(name, learned));
    if (notes.length) {
      say(`\n  Not everything agreed:`);
      for (const n of notes) say(`  · ${n}`);
    }
    if (!opts.write) { say(`\n  Nothing saved. \`retake routine learn --write\` to make this the standard.`); return; }
    const data = file ?? starter();
    data.routines[name] = learned;
    data.use = name;
    writeRoutines(DEMOS_DIR(), data);
    say(`\n✓ routine ${name} — read from your own work, not from Retake's defaults.`);
  });

routine
  .command("new")
  .argument("<name>", "kebab-case name, e.g. techtutor-vn")
  .description("a second standard — a different product, or a different language")
  .action((name: string) => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error("name must be kebab-case");
    const file = readRoutines(DEMOS_DIR()) ?? starter();
    if (file.routines[name]) throw new Error(`"${name}" already exists`);
    file.routines[name] = RoutineSchema.parse({});
    writeRoutines(DEMOS_DIR(), file);
    say(`✓ routine ${name} — \`retake routine set <key> <value> --as ${name}\` to shape it`);
  });

routine
  .command("use")
  .argument("<name>")
  .description("make this the standard new recordings get")
  .action((name: string) => {
    const file = readRoutines(DEMOS_DIR());
    if (!file) throw new Error("no routine yet — `retake routine init`");
    if (!file.routines[name]) throw new Error(`no routine called "${name}" — have: ${Object.keys(file.routines).join(", ")}`);
    file.use = name;
    writeRoutines(DEMOS_DIR(), file);
    say(`✓ using ${name}`);
  });

routine
  .command("set")
  .argument("<key>", "style | voice | rate | music | captions | mode | theme | typing | compressIdle | intro | outro | logo | brand | deliver | note (intro/outro: \"Title | subtitle\")")
  .argument("<value>")
  .option("--as <name>", "which routine to change (default: the one in use)")
  .description("change the standard once, for every recording that follows")
  .action((key: string, value: string, opts: { as?: string }) => {
    const file = readRoutines(DEMOS_DIR());
    if (!file) throw new Error("no routine yet — `retake routine init`");
    const which = opts.as ?? file.use;
    const current = file.routines[which];
    if (!current) throw new Error(`no routine called "${which}" — have: ${Object.keys(file.routines).join(", ")}`);

    const next: Record<string, unknown> = { ...current };
    switch (key.toLowerCase()) {
      case "style":
        if (!(value in STYLES)) throw new Error(`style is one of ${Object.keys(STYLES).join(", ")}`);
        next.style = value; break;
      case "voice":
        // A pace belongs to a voice. -34% suited Ryan and dragged on Andrew,
        // who starts slower — carrying the number across is how a routine
        // ended up sounding sluggish after a voice change.
        if (value !== current.voice && current.rate !== 0) {
          say(`ℹ pace reset from ${current.rate > 0 ? "+" : ""}${current.rate}% to natural — a pace set for ${current.voice} does not carry to ${value}. \`retake routine voices --rate <n>\` to hear and choose.`);
          next.rate = 0;
        }
        next.voice = value; break;
      case "rate":
        if (!/^-?\d+$/.test(value)) throw new Error("rate is a whole percent, -50 to 50 (0 is the voice's own pace)");
        next.rate = Number(value); break;
      case "music":
        next.music = /^(none|off|false)$/i.test(value) ? false : value; break;
      case "captions":
        if (!/^(on|off|true|false)$/i.test(value)) throw new Error("captions is on or off");
        next.captions = /^(on|true)$/i.test(value); break;
      case "mode":
        if (!/^(demo|launch)$/.test(value)) throw new Error("mode is demo or launch");
        next.mode = value; break;
      case "typing":
        if (!/^(natural|brisk)$/.test(value)) throw new Error("typing is natural or brisk");
        next.typing = value; break;
      case "compressidle":
        next.compressIdle = /^(on|true)$/i.test(value); break;
      case "theme": {
        const m = /^(#[0-9a-f]{3,8})\s*(?:,|\s)\s*(#[0-9a-f]{3,8})$/i.exec(value.trim());
        if (!m) throw new Error("theme is two hex colours: background,ink — e.g. \"#2f5d3f,#f7f4ea\"");
        next.theme = { background: m[1], ink: m[2] }; break;
      }
      case "note":
        next.note = value; break;
      case "outro":
      case "intro": {
        const k = key.toLowerCase() as "outro" | "intro";
        if (/^(none|off)$/i.test(value)) { delete next[k]; break; }
        const [title, subtitle] = value.split(/\s*\|\s*/);
        next[k] = { title, ...(subtitle ? { subtitle } : {}) };
        if (k === "outro") next.cards = true;
        break;
      }
      case "brand": {
        // The product's colours in one place: ground (the card), matte (the
        // frame, and the card's words), orb (the corner circles).
        const pairs: Record<string, string> = Object.fromEntries(value.split(/[\s,]+/).filter(Boolean).map((kv) => kv.split("=") as [string, string]));
        const bad = Object.entries(pairs).find(([k, v]) => !/^(ground|matte|orb)$/.test(k) || !/^#[0-9a-f]{6}$/i.test(v ?? ""));
        if (bad || !Object.keys(pairs).length) throw new Error('brand is ground=#rrggbb matte=#rrggbb orb=#rrggbb — any of them, e.g. "ground=#f2efe6 matte=#191d19"');
        const ground = pairs.ground ?? current.card?.background ?? current.theme?.ink;
        const matte = pairs.matte ?? current.theme?.background ?? current.card?.ink;
        if (!ground || !matte) throw new Error("give both ground and matte the first time");
        next.theme = { background: matte, ink: ground };
        next.card = { ...(current.card ?? { weight: 560, ornament: "none" }), background: ground, ink: matte, ...(pairs.orb ? { orb: pairs.orb } : {}) };
        break;
      }
      case "deliver":
        if (/^(none|off)$/i.test(value)) { delete next.deliver; break; }
        next.deliver = value.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"); break;
      case "logo": {
        if (!fs.existsSync(path.resolve(value))) throw new Error(`no such file: ${value}`);
        if (!/\.(svg|png|jpe?g)$/i.test(value)) throw new Error("the card draws an SVG, PNG or JPEG mark");
        if (!current.card) throw new Error("this routine has no card style yet — `retake routine setup` reads one off a north star");
        next.card = { ...current.card, logo: value }; break;
      }
      default:
        throw new Error(`no such setting "${key}" — style, voice, rate, music, captions, mode, theme, typing, compressIdle, intro, outro, logo, brand, deliver, note`);
    }

    const parsed = RoutineSchema.safeParse(next);
    if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    if (key === "voice" && value !== "silent" && !VOICES[value] && !/^[a-z]{2}-[A-Z]{2}-/.test(value)) {
      say(`ℹ "${value}" is not one of ${Object.keys(VOICES).join(", ")} and does not look like an edge-tts id (en-US-AriaNeural). \`retake routine voices\` lists what is here.`);
    }
    if (typeof parsed.data.music === "string" && !fs.existsSync(path.resolve(parsed.data.music))) {
      say(`ℹ ${parsed.data.music} is not there yet — the render will fail until it is. It ships inside your video, so it must be a track you may use.`);
    }
    file.routines[which] = parsed.data;
    writeRoutines(DEMOS_DIR(), file);
    say(describeRoutine(which, parsed.data));
  });

routine
  .command("voices")
  .description("hear the named voices once, then never discuss speed again")
  .option("--line <text>", "what they should say", "This is the voice your demos will use, at the pace they will use it.")
  .option("--rate <percent>", "try a speed", "0")
  .action(async (opts: { line: string; rate: string }) => {
    const { synthesize } = await import("./voice.js");
    const dir = path.resolve("outputs", ".voices");
    fs.mkdirSync(dir, { recursive: true });
    const rate = Number(opts.rate);
    if (!Number.isInteger(rate) || rate < -50 || rate > 50) throw new Error("--rate is a whole percent, -50 to 50");
    for (const [name, v] of Object.entries(VOICES)) {
      const out = path.join(dir, `${name}.mp3`);
      process.stdout.write(`  ${name.padEnd(14)} ${v.id} … `);
      try { synthesize(opts.line, v.id, out, rate); process.stdout.write(`${path.relative(process.cwd(), out)}\n`); }
      catch (e) { process.stdout.write(`✗ ${(e as Error).message}\n`); break; }
    }
    say(`\n  Listen, then lock it in:  retake routine set voice <name>`);
    say(`  Too fast or too slow is a rate, set once:  retake routine set rate -8`);
  });

routine
  .command("apply")
  .argument("[manifests...]", "default: every manifest in demos/")
  .option("--as <name>", "which routine to apply (default: the one in use)")
  .option("--voice <name>", "just this once: a different voice (a name, an edge-tts id, or silent)")
  .option("--style <name>", "just this once: showcase | fullscreen | mobile")
  .option("--rate <percent>", "just this once: a different pace")
  .option("--captions <on|off>", "just this once")
  .description("stamp the standard onto manifests that already exist")
  .action((files: string[], opts: { as?: string; voice?: string; style?: string; rate?: string; captions?: string }) => {
    const { name, routine: base } = pickRoutine(DEMOS_DIR(), opts.as);
    const { routine: r, said } = overrideRoutine(base, opts);
    if (said.length) say(`routine ${name}, just this once: ${said.join(" · ")}`);
    const targets = files.length
      ? files.map((f) => path.resolve(f))
      : fs.readdirSync(DEMOS_DIR()).filter(isDemoFile).map((f) => path.join(DEMOS_DIR(), f));
    if (!targets.length) throw new Error("no manifests in demos/");
    let touched = 0;
    for (const t of targets) {
      const { changed, skipped } = applyToManifest(t, r);
      if (changed.length) { touched++; say(`${path.relative(process.cwd(), t)}\n  ${changed.join("\n  ")}`); }
      for (const s of skipped) say(`${path.relative(process.cwd(), t)}\n  ℹ ${s}`);
    }
    say(`\n${touched}/${targets.length} changed to match routine ${name}. Re-render to see it: nothing here needs the browser again except a format change.`);
  });

routine
  .command("reference")
  .argument("[video]", "the north-star video — omit to see the current one")
  .option("--as <name>", "which routine (default: the one in use)")
  .description("set the one approved video every cut is held to, and hear up front what this routine cannot reproduce")
  .action(async (video: string | undefined, opts: { as?: string }) => {
    const file = readRoutines(DEMOS_DIR());
    if (!file) throw new Error("no routine yet — `retake routine init`");
    const name = opts.as ?? file.use;
    const r = file.routines[name];
    if (!r) throw new Error(`no routine called "${name}"`);
    const target = video ? path.resolve(video.replace(/^~/, process.env.HOME ?? "~")) : r.reference;
    if (!target) { say(`routine ${name} has no reference. \`retake routine reference <video>\` — the one cut you would be happy to get every time.`); return; }
    if (!fs.existsSync(target)) throw new Error(`no such video: ${target}`);
    const { ffmpegBin } = await import("./media-bin.js");
    const [facts] = await measureOutputs([{ name: path.basename(target), file: target }], ffmpegBin());
    say(`reference  ${target}`);
    say(`           ${facts.width}×${facts.height} · ${facts.fps}fps · ${facts.seconds.toFixed(1)}s · ${facts.hasAudio ? `narrated${facts.lufs !== null ? ` at ${facts.lufs.toFixed(1)} LUFS` : ""}` : "silent"}`);
    let next: Routine = video ? { ...r, reference: target } : r;
    // A routine with no look of its own takes the north star's — the cards,
    // their colours, the inset — rather than Retake's.
    if (video && !r.card && !r.theme) {
      const { grabFrame, readLook } = await import("./setup.js");
      const ff = ffmpegBin();
      const look = readLook({
        intro: grabFrame(ff, target, Math.min(0.8, facts.seconds / 4)),
        body: grabFrame(ff, target, facts.seconds / 2),
        outro: grabFrame(ff, target, Math.max(0, facts.seconds - 0.8)),
      }, facts);
      next = { ...next, style: look.style, cards: look.cards, mode: look.cards ? "launch" : r.mode, ...(look.theme ? { theme: look.theme } : {}), ...(look.card ? { card: { ...look.card, weight: 560, ornament: "none" as const } } : {}) };
      if (look.card || look.theme) say(`ℹ these colours are the north star's — if it is another product's video, \`retake routine set brand ground=#… matte=#…\` gives this product its own.`);
      say(`taken from it: ${look.style}${look.cards ? `, cards on ${look.card!.background} in ${look.card!.ink}` : ", no cards"}${look.theme ? `, inset on ${look.theme.background}` : ""}`);
      for (const n of look.notes) say(`  · ${n}`);
    }
    const gaps = preflightAgainst(facts, next);
    if (gaps.length) {
      say(`\n✗ before you record — routine ${name} cannot reproduce this yet:`);
      for (const g of gaps) say(`  · ${g}`);
    } else {
      say(`\n✓ nothing in the routine contradicts the reference. \`retake routine check\` scores each cut against it.`);
    }
    if (video) {
      file.routines[name] = next;
      writeRoutines(DEMOS_DIR(), file);
      say(`\nsaved as routine ${name}'s reference.`);
    }
  });

routine
  .command("check")
  .option("--as <name>", "which routine to judge against (default: the one in use)")
  .option("-o, --out <dir>", "output root", "outputs")
  .description("would a viewer see ONE set of videos? measures the finished files, not the manifests")
  .action(async (opts: { as?: string; out: string }) => {
    const { name, routine: r } = pickRoutine(DEMOS_DIR(), opts.as);
    const outRoot = path.resolve(opts.out);
    const done = readPlan(DEMOS_DIR()).filter((i) => i.status === "final" || i.status === "recorded");
    const files = done
      .map((i) => ({ name: i.name, file: path.join(outRoot, i.name, "demo.mp4") }))
      .filter((f) => fs.existsSync(f.file));
    if (!files.length) throw new Error(`nothing recorded yet under ${path.relative(process.cwd(), outRoot)} — \`retake routine run\` first`);

    const { ffmpegBin } = await import("./media-bin.js");
    say(`routine ${name} · measuring ${files.length} finished video${files.length === 1 ? "" : "s"}…\n`);
    const measured = await measureOutputs(files, ffmpegBin());
    for (const m of measured) {
      say(`  ${m.name.padEnd(26)} ${m.width}×${m.height} · ${m.fps}fps · ${m.seconds.toFixed(1)}s · ${m.hasAudio ? `voice${m.lufs !== null ? ` ${m.lufs.toFixed(1)} LUFS` : ""}` : "silent"}`);
    }
    const { PRESETS } = await import("./presets.js");
    const want = PRESETS[STYLES[r.style].preset];
    const { problems } = compareRoutine(measured, r, { width: want.width, height: want.height, fps: want.fps });

    // Against the north star: the cards, the frame, the sound — what a person
    // would otherwise only find by watching.
    if (r.reference && fs.existsSync(r.reference)) {
      const [ref] = await measureOutputs([{ name: "reference", file: r.reference }], ffmpegBin());
      say(`\nagainst the reference (${path.basename(r.reference)}):`);
      for (const f of files) {
        const work = path.join(outRoot, f.name, ".reference");
        const scores = await compareToReference(ffmpegBin(), r.reference, f.file, r, work);
        const m = measured.find((x) => x.name === f.name)!;
        if (ref.hasAudio !== m.hasAudio) problems.push(`${f.name}: ${ref.hasAudio ? "silent, the reference is narrated" : "narrated, the reference is silent"}`);
        if (ref.lufs !== null && m.lufs !== null && Math.abs(ref.lufs - m.lufs) > 2) problems.push(`${f.name}: voice at ${m.lufs.toFixed(1)} LUFS, the reference at ${ref.lufs.toFixed(1)} — a viewer reaches for the volume`);
        for (const sc of scores) {
          say(`  ${f.name.padEnd(26)} ${sc.label.padEnd(22)} ${(sc.score * 100).toFixed(1)}%  ${sc.pass ? "✓" : "✗"} ${sc.note}`);
          if (!sc.pass) problems.push(`${f.name}: ${sc.label} — ${sc.note} (${(sc.score * 100).toFixed(1)}% alike); compare ${path.relative(process.cwd(), work)}`);
        }
      }
    }
    if (!problems.length) {
      say(`\n✓ one set. Every video matches the ${name} standard${r.reference ? ", the reference," : ""} and each other.`);
      return;
    }
    say(`\n✗ these would not read as one set:`);
    for (const p of problems) say(`  · ${p}`);
    say(`\n  Size and frame rate are a re-render, not a re-record: \`retake render outputs/<name> --preset ${STYLES[r.style].preset}\`.`);
    process.exitCode = 2;
  });

routine
  .command("run")
  .option("--as <name>", "which routine to record with (default: the one in use)")
  .option("--only <names>", "just these plan items, comma-separated — re-records them whatever their status")
  .option("-n, --limit <count>", "stop after this many")
  .option("--preview", "stop at the preview capture; do not close the cycle at full quality", false)
  .option("-o, --out <dir>", "output root", "outputs")
  .option("--voice <name>", "just this batch: a different voice (a name, an edge-tts id, or silent)")
  .option("--style <name>", "just this batch: showcase | fullscreen | mobile")
  .option("--rate <percent>", "just this batch: a different pace")
  .option("--captions <on|off>", "just this batch")
  .option("-e, --env <path>", "environment file — bring the app up clean and prove it before recording")
  .option("--scheduled", "started by `retake routine schedule`: say how it went in a notification", false)
  .description("work the plan: stamp, dry-run, record and finish each demo that is not done")
  .action(async (opts: { as?: string; only?: string; limit?: string; preview: boolean; out: string; voice?: string; style?: string; rate?: string; captions?: string; env?: string; scheduled: boolean }) => {
    if (!opts.scheduled) { await runPlan(opts); return; }
    // Nobody is watching a scheduled run, so how it went has to come to them.
    const { notify } = await import("./schedule.js");
    say(`\n═══ scheduled run · ${new Date().toLocaleString()}`);
    try {
      const { results, routine: r } = await runPlan(opts);
      const done = results.filter((x) => x.status === "final");
      const short = results.filter((x) => x.status !== "final");
      if (!results.length) notify("Retake", "Nothing to record today — no drafted story is waiting in the plan.");
      else if (done.length && !short.length) notify("Retake", `${done.map((x) => x.name).join(", ")} ${done.length === 1 ? "is" : "are"} ready${r.deliver ? ` in ${path.basename(r.deliver)}` : ""}.`);
      else notify("Retake", short.map((x) => `${x.name}: ${x.note ?? x.status}`).join(" · ").slice(0, 220));
    } catch (e) {
      notify("Retake — the scheduled run stopped", (e as Error).message.slice(0, 220));
      throw e;
    }
  });

async function runPlan(opts: { as?: string; only?: string; limit?: string; preview: boolean; out: string; voice?: string; style?: string; rate?: string; captions?: string; env?: string }) {
  const { name, routine: base } = pickRoutine(DEMOS_DIR(), opts.as);
  const { routine: r, said } = overrideRoutine(base, opts);
  if (said.length) say(`just this batch: ${said.join(" · ")} (demos/routine.json is unchanged)`);
  const limit = opts.limit === undefined ? undefined : Number(opts.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit is a whole number of videos");
  say(`routine ${name}`);
  const results = await runRoutine({
    demosDir: DEMOS_DIR(),
    outRoot: path.resolve(opts.out),
    routine: r,
    only: opts.only?.split(",").map((s) => s.trim()).filter(Boolean),
    limit,
    previewOnly: opts.preview,
    envFile: opts.env ? path.resolve(opts.env) : environmentFor(DEMOS_DIR(), r),
    log: say,
  });
  if (results.some((x) => x.status === "failed")) process.exitCode = 2;
  return { results, routine: r };
}

routine
  .command("schedule")
  .argument("[every]", "daily | weekdays | off — omit to see the current schedule")
  .argument("[at]", "24-hour time", "09:00")
  .option("-n, --count <videos>", "videos per run", "1")
  .description("let the routine run itself: the next planned video, recorded, judged and delivered on a cadence")
  .action(async (every: string | undefined, at: string, opts: { count: string }) => {
    const { installSchedule, removeSchedule, readSchedule, scheduleLoaded, describeSchedule } = await import("./schedule.js");
    const root = process.cwd();
    if (!every) {
      const s = readSchedule(root);
      if (!s) { say("not scheduled — `retake routine schedule weekdays 09:00` records the next planned video every weekday morning."); return; }
      const live = scheduleLoaded(s.label);
      say(`${live ? "✓" : "✗"} ${describeSchedule(s)} — ${live ? `held by ${s.mechanism}` : `written, but ${s.mechanism} is not holding it; schedule it again`}`);
      say(`  log: ${path.relative(root, path.join(root, ".retake", "schedule.log"))}`);
      return;
    }
    if (every === "off") { say(removeSchedule(root) ? "✓ unscheduled." : "nothing was scheduled."); return; }
    if (every !== "daily" && every !== "weekdays") throw new Error("say daily, weekdays or off");
    // It will run with nobody there. Everything a run needs must already be
    // true, so check it now rather than learn it from tomorrow's notification.
    const { name, routine: r } = pickRoutine(DEMOS_DIR(), undefined);
    const drafted = readPlan(DEMOS_DIR()).filter((i) => (i.status === "todo" || i.status === "failed") && ["yaml", "yml", "json"].some((x) => fs.existsSync(path.join(DEMOS_DIR(), `${i.name}.${x}`))));
    const bin = entry("cli");
    const s = installSchedule(root, { every, at, count: Number(opts.count) }, [bin.command, ...bin.args, "routine", "run", "--scheduled", "-n", String(Number(opts.count))]);
    say(`✓ routine ${name} runs ${describeSchedule(s)} — the next planned video, judged against the north star${r.deliver ? `, delivered to ${r.deliver}` : ""}.`);
    say(`  ${drafted.length ? `${drafted.length} drafted and waiting: ${drafted.slice(0, 4).map((i) => i.name).join(", ")}${drafted.length > 4 ? "…" : ""}` : "nothing drafted is waiting — add stories to demos/plan.json and draft them, or the runs will have nothing to do"}`);
    if (!r.reference) say(`  ℹ no north star: every take will be delivered unjudged. \`retake routine reference <video>\`.`);
    say(`  A notification says how each run went. \`retake routine schedule off\` stops it.`);
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`✗ ${(e as Error).message}\n`);
  process.exit(1);
});
