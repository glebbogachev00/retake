#!/usr/bin/env node
/**
 * retake — demo-as-code.
 *
 *   retake install                                set up Claude Code / Codex + this folder as the workspace
 *   retake init                                   just the workspace: demos/, outputs/, .env, .gitignore
 *   retake doctor                                 is everything in place?
 *   retake ui                                     the review window on :4310
 *   retake run demos/x.yaml                       record + render → outputs/x/
 *   retake run demos/x.yaml --headed --no-render  watch the browser, keep only the raw take
 *   retake render outputs/x                       re-render from the existing take (--preset to switch)
 *   retake check outputs/x                        pass/fail on resolution, fps, duration, files
 *   retake verify outputs/x                       did it LOOK right — each scene's `expect`, judged
 *   retake sense outputs/x                        does the run ADD UP — what went in vs what came out
 *   retake destroy demos/x.yaml                   the flows nobody wrote down — abuse this demo nine ways
 *   retake notes                                  read outputs/ back: what keeps going wrong, and what it costs
 *   retake dry demos/x.yaml                       every selector and wait, no camera
 *   retake validate demos/x.yaml                  schema check only
 *   retake presets                                list quality presets
 *   retake list                                   manifests in ./demos
 *   retake describe <name> <url> "<what>"         scout + model → demos/<name>.yaml
 *
 * Run from a clone, the `.ts` source goes through tsx (`npm run retake -- …`);
 * installed from npm, dist/cli.js is the `retake` binary. Same file.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { loadManifest, resolve, warnings, type Manifest } from "./manifest.js";
import { acquireLock, captureHash, EXPENSIVE_TAKE_SECONDS, keepPrevious, keptTakes, lastCaptureSeconds, unchangedUpTo, record, releaseLock, restoreKept, restorePrevious, stashPrevious, type Take } from "./record.js";
import { check, render } from "./render.js";
import { presetNames } from "./presets.js";
import { applyTidy, mb, planTidy } from "./tidy.js";
import { verify } from "./ext/verify.js";
import { notes } from "./ext/notes.js";
import { sense } from "./ext/sense.js";
import { SHAPES, describePlan, describeTrials, planDestroy, refuseToRun, tryCandidates } from "./ext/destroy.js";
import { PKG_ROOT, VERSION, entry } from "./paths.js";
import { SECRET_NAME, writeEnvFile } from "./env.js";

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
  .option("--reuse", "reuse the last raw recording if nothing that shapes it changed (re-render only)", false)
  .option("--gif", "also produce a GIF (overrides the manifest)", false)
  .option("--no-master", "skip the archival CRF-14 master — roughly halves render on a long take, and the deliverable is marginally better for it (one encode instead of an encode of an encode)")
  .option("--until <scene>", "record up to the end of this scene, then stop (iterate on one beat without paying for the whole take)")
  .option("--from <scene>", "start the take at this scene — earlier steps still run, at full speed and off camera, so a demo whose ENDING changed stops costing its beginning")
  .option("--name <name>", "write to outputs/<name> instead of the manifest's name — revise a cut without overwriting the published one")
  .action(async (file: string, opts: { out: string; headed: boolean; skipSeed: boolean; render: boolean; keepRaw: boolean; preset?: string; reuse: boolean; gif: boolean; master: boolean; until?: string; from?: string; name?: string }) => {
    const loaded = loadManifest(file);
    // Asking for a preset means asking for its SHAPE. A manifest that pins its
    // own `viewport` used to win silently, so `--preset draft` recorded at
    // full size and saved nothing — on the one demo where iterating cheaply
    // mattered most, and with a failing "matches draft" check as the only
    // hint. An explicit --preset now drops the pin.
    let manifest = loaded.manifest;
    if (opts.preset) {
      const { viewport: pinned, ...rest } = loaded.manifest;
      manifest = { ...rest, preset: opts.preset };
      if (pinned) say(`ℹ --preset ${opts.preset} overrides this manifest's viewport (${pinned.width}×${pinned.height}); recording at the preset's own size`);
    }
    if (opts.gif) manifest = { ...manifest, outputs: { ...manifest.outputs, gif: true } };
    if (opts.preset && !presetNames().includes(opts.preset)) throw new Error(`unknown preset ${opts.preset} — one of ${presetNames().join(", ")}`);
    const dir = loaded.dir;
    if (opts.name && !/^[a-z0-9-]+$/.test(opts.name)) throw new Error("--name must be kebab-case");
    const outDir = path.resolve(opts.out, opts.name ?? manifest.name);
    acquireLock(outDir); // throws if another run owns this folder

    // Reuse: same capture hash + raw video present → skip the browser.
    let take: Take | undefined;
    const takePath = path.join(outDir, "take.json");
    if (opts.reuse && fs.existsSync(takePath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(takePath, "utf8")) as Take;
        if (prev.captureHash && prev.captureHash === captureHash(manifest) && prev.video && fs.existsSync(prev.video) && !prev.partial) take = prev;
      } catch { /* record fresh */ }
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
        take = await record(manifest, { until: opts.until, from: opts.from, outDir, headed: opts.headed, skipSeed: opts.skipSeed, manifestDir: dir, log: say, locked: true });
      } catch (e) {
        if (restorePrevious(outDir)) say("↩ recording failed — your previous take has been put back");
        releaseLock(outDir);
        throw e;
      }
      keepPrevious(outDir, say);
    }
    say(`■ take done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${take.ok ? "all steps ok" : "SOME STEPS FAILED"} · ${take.video ?? "no video"}`);

    try {
      if (opts.render) {
        say(`[stage] render start`);
        const tr = Date.now();
        const a = await render(manifest, take, outDir, { noMaster: opts.master === false, log: (l) => { if (!l.startsWith("$")) say(l); } });
        if (!opts.keepRaw) cleanRaw(outDir, take, a.mp4);
        for (const f of [a.master, a.mp4, a.gif, a.thumbnail, a.proofLog]) if (f) say(`✓ ${path.relative(process.cwd(), f)}`);
        if (a.facts) say(`  ${a.facts.width}×${a.facts.height} @ ${a.facts.fps}fps · ${a.facts.duration.toFixed(1)}s · ${a.facts.encoder} · mp4 ${(a.facts.sizes["demo.mp4"] / 1e6).toFixed(1)} MB${a.gif ? ` · gif ${(a.facts.sizes["demo.gif"] / 1e6).toFixed(1)} MB (${a.facts.gifTool})` : ""} · camera on ${a.facts.cameraScenes} scenes${a.facts.cached ? " · cached" : ""} · render ${((Date.now() - tr) / 1000).toFixed(1)}s`);
        const c = check(outDir, manifest);
        say(c.ok ? "check: pass" : "check: FAIL\n  " + c.lines.filter((l) => l.startsWith("FAIL")).join("\n  "));
      }
      say(`[stage] done`);
    } finally {
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
  .action((opts: { out: string; apply: boolean; deep: boolean; orphans: boolean }) => {
    const root = path.resolve(opts.out);
    const plan = planTidy(root, { deep: opts.deep, orphans: opts.orphans, demosDir: path.resolve("demos") });
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
  .action((dir: string, manifestFile?: string) => {
    const outDir = path.resolve(dir);
    const file = manifestFile ?? path.join("demos", `${path.basename(outDir)}.yaml`);
    if (!fs.existsSync(file)) throw new Error(`no ${file} — pass the manifest path`);
    const { manifest } = loadManifest(file);
    const v = verify(manifest, outDir, say);
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
  .option("--no-master", "skip the archival CRF-14 master — halves render on a long take")
  .option("--out <dir>", "write the render into a NEW directory, leaving the original untouched")
  .action(async (dir: string, manifestFile: string | undefined, opts: { preset?: string; scene?: string; gif: boolean; force: boolean; master: boolean; out?: string }) => {
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
    let manifest = opts.preset ? { ...loaded.manifest, preset: opts.preset } : loaded.manifest;
    if (opts.gif) manifest = { ...manifest, outputs: { ...manifest.outputs, gif: true } };
    acquireLock(path.resolve(dir));
    try {
      const a = await render(manifest, take, path.resolve(dir), { log: say, force: opts.force, scene: opts.scene, noMaster: opts.master === false });
      for (const f of [a.master, a.mp4, a.gif, a.thumbnail]) if (f) say(`✓ ${path.relative(process.cwd(), f)}`);
      if (a.facts) say(`  ${Object.entries(a.facts.timings).map(([k, v]) => `${k} ${v}s`).join(" · ")}${a.facts.cached ? " (cached)" : ""}`);
      if (!opts.scene) say(check(path.resolve(dir), manifest).lines.join("\n"));
    } finally {
      releaseLock(path.resolve(dir));
    }
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
  const example = path.join(root, "demos", "example.yaml");
  if (!fs.existsSync(example) && fs.readdirSync(path.join(root, "demos")).length === 0) {
    fs.copyFileSync(path.join(PKG_ROOT, "demos", "example.yaml"), example);
    made.push("demos/example.yaml");
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

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`✗ ${(e as Error).message}\n`);
  process.exit(1);
});
