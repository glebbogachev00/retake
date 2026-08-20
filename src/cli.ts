#!/usr/bin/env -S npx tsx
/**
 * retake — demo-as-code.
 *
 *   retake run demos/capture-hero.yaml            record + render → outputs/capture-hero/
 *   retake run demos/x.yaml --headed --no-render  watch the browser, keep only the raw take
 *   retake render outputs/capture-hero            re-render artifacts from an existing take (--preset to switch)
 *   retake check outputs/capture-hero             pass/fail on resolution, fps, duration, files
 *   retake presets                                list quality presets
 *   retake validate demos/x.yaml                  schema check only
 *   retake list                                   manifests in ./demos
 *   retake ui                                     local one-window UI on :4310
 *   retake describe <name> <url> "<what>"         scout + model → demos/<name>.yaml
 */
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadManifest, warnings } from "./manifest.js";
import { acquireLock, captureHash, record, releaseLock, type Take } from "./record.js";
import { check, render } from "./render.js";
import { presetNames } from "./presets.js";

// The manifest may reference ${VARS}; load .env before any command reads one.
// (`describe` and the UI used to do this individually, so a plain `run` from
// the terminal silently saw empty values — which is how a whole take can fail
// at a login without saying why.)
try {
  const { loadDotenv } = await import("./describe.js");
  loadDotenv(process.cwd());
} catch { /* .env is optional */ }

const program = new Command();
program.name("retake").description("Rerun the demo instead of re-recording it.").version("0.1.0");

const say = (l: string) => process.stdout.write(l + "\n");

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
  .action(async (file: string, opts: { out: string; headed: boolean; skipSeed: boolean; render: boolean; keepRaw: boolean; preset?: string; reuse: boolean; gif: boolean }) => {
    const loaded = loadManifest(file);
    let manifest = opts.preset ? { ...loaded.manifest, preset: opts.preset } : loaded.manifest;
    if (opts.gif) manifest = { ...manifest, outputs: { ...manifest.outputs, gif: true } };
    if (opts.preset && !presetNames().includes(opts.preset)) throw new Error(`unknown preset ${opts.preset} — one of ${presetNames().join(", ")}`);
    const dir = loaded.dir;
    const outDir = path.resolve(opts.out, manifest.name);
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
    say(`▶ ${manifest.title ?? manifest.name} → ${path.relative(process.cwd(), outDir)}${take ? " · reusing last recording" : ""}`);
    say(`[stage] capture ${take ? "skip" : "start"}`);

    const t0 = Date.now();
    if (!take) {
      // Wipe everything except the lock.
      for (const f of fs.readdirSync(outDir)) if (f !== ".retake-lock") fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
      try {
        take = await record(manifest, { outDir, headed: opts.headed, skipSeed: opts.skipSeed, manifestDir: dir, log: say, locked: true });
      } catch (e) {
        releaseLock(outDir);
        throw e;
      }
    }
    say(`■ take done in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${take.ok ? "all steps ok" : "SOME STEPS FAILED"} · ${take.video ?? "no video"}`);

    try {
      if (opts.render) {
        say(`[stage] render start`);
        const tr = Date.now();
        const a = await render(manifest, take, outDir, { log: (l) => { if (!l.startsWith("$")) say(l); } });
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
  .command("render")
  .argument("<dir>", "an outputs/<name> dir containing take.json")
  .argument("[manifest]", "manifest to use (default: from take.json's sibling manifest path or demos/<name>.yaml)")
  .option("--preset <name>", "override the manifest's preset for this render")
  .option("--scene <label>", "render just one scene to scene-<label>.mp4 (fast, hardware encode)")
  .option("--gif", "also produce a GIF", false)
  .option("--force", "ignore the render cache", false)
  .action(async (dir: string, manifestFile: string | undefined, opts: { preset?: string; scene?: string; gif: boolean; force: boolean }) => {
    const takePath = path.join(dir, "take.json");
    const take = JSON.parse(fs.readFileSync(takePath, "utf8")) as Take;
    const name = path.basename(path.resolve(dir));
    const mf = manifestFile ?? guessManifest(name);
    const loaded = loadManifest(mf);
    let manifest = opts.preset ? { ...loaded.manifest, preset: opts.preset } : loaded.manifest;
    if (opts.gif) manifest = { ...manifest, outputs: { ...manifest.outputs, gif: true } };
    acquireLock(path.resolve(dir));
    try {
      const a = await render(manifest, take, path.resolve(dir), { log: say, force: opts.force, scene: opts.scene });
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

program
  .command("agent")
  .description("print the config to paste into Claude Code, Codex, or Cursor")
  .option("--ui <url>", "the Retake window to report into", "http://localhost:4310")
  .action((o: { ui: string }) => {
    const node = process.execPath;
    const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const tools = path.join(process.cwd(), "src", "operator", "tools.ts");
    // RETAKE_UI is what makes the app a window onto the work rather than a
    // folder you check afterwards: the tools report progress there as they go.
    const env = { RETAKE_ROOT: process.cwd(), RETAKE_UI: o.ui };
    const cfg = { mcpServers: { retake: { command: node, args: [tsx, tools], env } } };
    say("Add Retake to your agent, then ask it for a demo in plain English.\n");
    say("Claude Code — run this once:");
    say(`  claude mcp add-json retake '${JSON.stringify(cfg.mcpServers.retake)}'\n`);
    say("Codex — add to ~/.codex/config.toml:");
    say(`  [mcp_servers.retake]`);
    say(`  command = ${JSON.stringify(node)}`);
    say(`  args = ${JSON.stringify([tsx, tools])}`);
    say(`  env = { RETAKE_ROOT = ${JSON.stringify(process.cwd())}, RETAKE_UI = ${JSON.stringify(o.ui)} }\n`);
    say("Cursor / anything else that speaks MCP — .cursor/mcp.json or equivalent:");
    say(JSON.stringify(cfg, null, 2) + "\n");
    say("Then just say: “record a demo of my app at localhost:3000 showing the sign-up flow”.");
    say(`Keep ${o.ui} open while it works — the plan, the run and the video appear there.`);
    say("Retake will not start your app from outside its own window unless you add RETAKE_ALLOW_START=1 above.");
  });

program
  .command("dry")
  .description("run the manifest with no camera and report what would fail")
  .argument("<manifest>")
  .action(async (file: string) => {
    const { manifest, dir } = loadManifest(file);
    const { dryRun } = await import("./dryrun.js");
    const r = await dryRun(manifest, dir, say);
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
    for (const p of Object.values(PRESETS)) say(`${p.name.padEnd(16)} ${String(p.width + "×" + p.height).padEnd(10)} ${p.fps}fps  scale ${p.scale}×  ${p.layout.padEnd(5)} — ${p.description}`);
  });

program
  .command("validate")
  .argument("<manifest>")
  .action((file: string) => {
    const { manifest } = loadManifest(file);
    say(`ok: ${manifest.name} · ${manifest.steps.length} steps · ${manifest.steps.filter((s) => s.action === "scene").length} scenes`);
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
    const d = await draftManifest({ name, url, describe: what, scout: sc, provider, project: opts.project });
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
