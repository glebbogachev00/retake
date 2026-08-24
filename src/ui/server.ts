/**
 * `retake ui` — the one-window loop: pick or describe a demo → edit → run →
 * watch → fix → run. A tiny local HTTP server, no framework, no build step.
 *
 *   GET  /                          the page
 *   GET  /api/demos                 [{name,title,file,lastTake}]
 *   GET  /api/demos/:name           { yaml }
 *   PUT  /api/demos/:name           { yaml }  → validate + save
 *   POST /api/demos                 { name, url, describe } → starter manifest
 *   POST /api/describe              { name, url, describe } → scout + model → draft manifest (saved)
 *   GET  /api/provider              { active, available }
 *   GET  /api/presets               [{name, ...}]
 *   GET/PUT/DELETE /api/drafts/:id   an unfinished "new demo" (auto-saved as you go)
 *   DELETE /api/demos/:name         remove a demo (manifest + outputs)
 *   PATCH /api/demos/:name/settings { preset?, layout?, camera?, cursor? } → edits keys, keeps comments
 *   PATCH /api/demos/:name/scene    { label, caption?, camera?, zoom?, holdMs? } → edits one scene in place
 *   PATCH /api/demos/:name/trim     { head, tail } → seconds cut from the finished video
 *   POST /api/run/:name             start a run; returns { runId }
 *   GET  /api/run/:name/stream      SSE: log lines, then `done`
 *   GET  /api/take/:name            outputs/<name>/take.json (+ proof-log text)
 *   GET  /out/:name/<file>          artifacts (mp4/gif/png/md)
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Manifest, loadManifest } from "../manifest.js";
import { PRESETS } from "../presets.js";
import { draftManifest, loadDotenv, pickProvider, proposeEdits, providerStatus, scout, suggestIdeas, type Scout } from "../describe.js";
import { applyEdits, receiptsFor } from "../edits.js";
import { dryRun } from "../dryrun.js";
import { startOperator, getSession, addPending, answerPending, markDone, stopSession } from "../operator/run.js";
import { ffmpegBin, gifskiBin, makeGif } from "../render.js";
import { captureHash } from "../record.js";
import { digest } from "../digest.js";
import { startOffer, startApp, listeningPorts } from "../appserver.js";
import { PKG_ROOT, PROJECT_ROOT, VERSION, entry } from "../paths.js";
import { SECRET_NAME, missingSecrets, writeEnvFile } from "../env.js";

const ROOT = PROJECT_ROOT;
const DEMOS = path.join(ROOT, "demos");
/** Where takes land. Default outputs/ in the project; changeable in Settings
    (RETAKE_OUT). Read lazily so a settings change applies without a restart. */
function outRoot(): string {
  const v = process.env.RETAKE_OUT?.trim();
  return v ? path.resolve(v.replace(/^~/, os.homedir())) : path.join(ROOT, "outputs");
}
const OUT_DEFAULT = path.join(ROOT, "outputs");
const DRAFTS = path.join(ROOT, ".drafts");
const DEMO_PROJECTS = path.join(DRAFTS, "demo-projects.json");

/** Unfinished "new demo" flows. Saved on every keystroke, so walking away at
    step 4 loses nothing; named "project-N" until the person names it. */
type Draft = { id: string; name: string; url: string; project: string; describe: string; step: number; updated: string };
function listDrafts(): Draft[] {
  if (!fs.existsSync(DRAFTS)) return [];
  return fs.readdirSync(DRAFTS).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(DRAFTS, f), "utf8")) as Draft; } catch { return null; } }).filter((d): d is Draft => !!d).sort((a, b) => b.updated.localeCompare(a.updated));
}
function nextProjectName(): string {
  const taken = new Set([...listDrafts().map((d) => d.name), ...(fs.existsSync(DEMOS) ? fs.readdirSync(DEMOS).map((f) => f.replace(/\.ya?ml$/, "")) : [])]);
  for (let i = 1; ; i++) if (!taken.has(`project-${i}`)) return `project-${i}`;
}
const HERE = path.dirname(fileURLToPath(import.meta.url));

type Run = { proc: ChildProcess | null; lines: string[]; done: boolean; code: number | null; listeners: Set<http.ServerResponse>; stage: string; startedAt: number; stageAt: number; estimate: { capture: number; render: number } };

/** Push a line / stage into a run and to everyone streaming it. */
function emit(run: Run, line: string) {
  run.lines.push(line);
  for (const res of run.listeners) res.write(`data: ${JSON.stringify(line)}\n\n`);
}
function setStage(run: Run, stage: string) {
  run.stage = stage; run.stageAt = Date.now();
  for (const res of run.listeners) res.write(`event: stage\ndata: ${JSON.stringify({ stage, at: run.stageAt, estimate: run.estimate, startedAt: run.startedAt })}\n\n`);
}
function finish(run: Run, code: number) {
  run.done = true; run.code = code;
  for (const res of run.listeners) { res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`); res.end(); }
  run.listeners.clear();
}

/** Deterministic repairs for what a dry run finds — no model needed.
    Strict-mode collision → pick the first visible match. */
function autoRepair(yamlText: string, failures: string[]): { yaml: string; fixes: string[] } {
  const fixes: string[] = [];
  const doc = YAML.parseDocument(yamlText);
  const steps = doc.get("steps") as YAML.YAMLSeq | undefined;
  for (const f of failures) {
    const m = /^✗ \[(\d+)\] \w+ (.+?) — .*strict mode violation/.exec(f);
    if (!m || !steps) continue;
    const n = steps.items[Number(m[1])] as YAML.YAMLMap;
    const sel = n && typeof n.get === "function" ? String(n.get("selector") ?? "") : "";
    if (sel && !/>> nth=/.test(sel)) { n.set("selector", `${sel} >> nth=0`); fixes.push(`step ${m[1]}: "${sel}" matched several — using the first`); }
  }
  return { yaml: doc.toString(), fixes };
}
const runs = new Map<string, Run>();

const json = (res: http.ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => ok(b));
  });
const safeName = (s: string) => /^[a-z0-9-]+$/.test(s);
const MIME: Record<string, string> = { ".mp4": "video/mp4", ".gif": "image/gif", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".md": "text/markdown", ".json": "application/json", ".html": "text/html", ".yaml": "text/yaml" };

/** A short name for "the app at this URL": the last path segment if there
    is one (demo.playwright.dev/todomvc → todomvc), else the host without
    www and TLD (www.saucedemo.com → saucedemo). localhost keeps its port —
    that is the only thing telling two local apps apart. */
function shortGroup(url: string): string {
  if (!url) return "unsorted";
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) return seg.slice(0, 24);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return `localhost:${u.port || "80"}`;
    return u.hostname.replace(/^www\./, "").replace(/\.[a-z]{2,}$/i, "").slice(0, 24);
  } catch { return url.replace(/^https?:\/\//, "").slice(0, 24); }
}

function projectKey(project: string): string {
  return path.resolve(project.replace(/^~/, os.homedir()).trim());
}
function demoProjects(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(DEMO_PROJECTS, "utf8")) as Record<string, string>; }
  catch { return {}; }
}
function assignDemoProject(name: string, project: string) {
  const map = demoProjects();
  map[name] = projectKey(project);
  fs.mkdirSync(DRAFTS, { recursive: true });
  fs.writeFileSync(DEMO_PROJECTS, JSON.stringify(map, null, 2) + "\n");
}
function unassignDemoProject(name: string) {
  const map = demoProjects();
  if (!(name in map)) return;
  delete map[name];
  fs.writeFileSync(DEMO_PROJECTS, JSON.stringify(map, null, 2) + "\n");
}

function listDemos(project?: string) {
  if (!fs.existsSync(DEMOS)) return [];
  const wanted = project?.trim() ? projectKey(project) : null;
  const assignments = demoProjects();
  const byUrl = new Map<string, string>();
  for (const f of fs.readdirSync(DEMOS).filter((x) => /\.ya?ml$/.test(x))) {
    try { const mm = loadManifest(path.join(DEMOS, f)).manifest; const asg = assignments[mm.name]; if (asg && mm.url && !byUrl.has(mm.url)) byUrl.set(mm.url, asg); } catch { /* invalid manifest: no vote */ }
  }
  return fs
    .readdirSync(DEMOS)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => {
      const file = path.join(DEMOS, f);
      let title = "", name = f.replace(/\.ya?ml$/, ""), valid = true, url = "", settings: Record<string, unknown> = {};
      try {
        const m = loadManifest(file).manifest;
        title = m.title ?? "";
        name = m.name;
        url = m.url;
        settings = {
          preset: m.preset, layout: m.layout ?? "default",
          camera: typeof m.camera === "string" ? m.camera : "auto",
          cursor: m.cursor === false ? "none" : typeof m.cursor === "object" && m.cursor.style === "touch" ? "touch" : "default",
          trim: m.trim,
          tempo: m.tempo ?? 1,
          scenes: m.steps.filter((st) => st.action === "scene").map((st) => ({ label: st.label, caption: st.caption ?? "", holdMs: st.holdMs ?? null, camera: st.camera === "static" ? "static" : typeof st.camera === "object" && st.camera.zoom ? st.camera.zoom : "auto" })),
        };
      } catch {
        valid = false;
      }
      // A demo nobody assigned to a folder inherits the folder of any demo
      // that points at the same app — otherwise an agent's new draft for
      // Capture lands in a second "localhost:3100" fold next to "capture".
      const assigned = assignments[name] ?? (url ? byUrl.get(url) : undefined);
      const group = assigned ? path.basename(assigned) : shortGroup(url);
      const take = path.join(outRoot(), name, "take.json");
      let lastTake: unknown = null;
      // Does the browser need to run again, or is a re-render enough? The
      // capture hash answers it, so the UI never has to ask the user.
      let needsRecord = true;
      if (fs.existsSync(take)) {
        try {
          const t = JSON.parse(fs.readFileSync(take, "utf8"));
          lastTake = { finishedAt: t.finishedAt, ok: t.ok, partial: t.partial ?? null, duration: Math.round((t.duration - t.trimBefore) * 10) / 10 };
          const m = loadManifest(file).manifest;
          needsRecord = !t.captureHash || t.captureHash !== captureHash(m) || !!t.partial || !t.video || !fs.existsSync(t.video);
        } catch { /* ignore */ }
      }
      return { name, file: f, title, url, group, valid, settings, lastTake, needsRecord };
    })
    .filter((demo) => !wanted || assignments?.[demo.name] === wanted);
}

function starterManifest(name: string, url: string, describe: string): string {
  const doc = {
    name,
    title: describe.trim() || name,
    url,
    preset: "post-landscape",
    steps: [
      { action: "scene", label: "open", caption: describe.trim() ? describe.trim().slice(0, 60) : "Opening shot" },
      { action: "wait", ms: 1500 },
      { action: "click", selector: "TODO — a selector, e.g. button:has-text('Start')", pauseAfter: 800 },
      { action: "scene", label: "result", caption: "What just happened." },
      { action: "wait", ms: 2500 },
    ],
    outputs: { mp4: true, gif: true, thumbnail: { scene: "result" } },
  };
  return (
    `# ${describe.trim() || name}\n# Starter manifest — replace the TODO selector, add scenes. Run to see it.\n` +
    `# Describe mode will draft these steps by scouting ${url} once a model is wired in.\n\n` +
    YAML.stringify(doc)
  );
}

/** How long the last take took, per stage — the progress bar's estimate. */
function estimateFor(name: string): { capture: number; render: number } {
  const dir = path.join(outRoot(), name);
  let capture = 90, render = 45;
  try { const t = JSON.parse(fs.readFileSync(path.join(dir, "take.json"), "utf8")); if (t.captureSec) capture = t.captureSec; } catch { /* default */ }
  try { const f = JSON.parse(fs.readFileSync(path.join(dir, "facts.json"), "utf8")); const sum = Object.values(f.timings ?? {}).reduce((a: number, b) => a + Number(b), 0) as number; if (sum > 0) render = sum + 3; } catch { /* default */ }
  return { capture, render };
}

function startRun(name: string, mode: { preview?: boolean; reuse?: boolean; gif?: boolean; renderOnly?: boolean } = {}): Run {
  const existing = runs.get(name);
  if (existing && !existing.done) return existing;
  const file = fs.readdirSync(DEMOS).find((f) => f.replace(/\.ya?ml$/, "") === name);
  if (!file) throw new Error(`no demos/${name}.yaml`);
  const cli = entry("cli");
  const args = mode.renderOnly
    ? [...cli.args, "render", path.join(outRoot(), name), ...(mode.gif ? ["--gif"] : [])]
    : [...cli.args, "run", path.join(DEMOS, file), "--out", outRoot()];
  if (!mode.renderOnly) {
    if (mode.preview) args.push("--preset", "preview-fast", "--reuse");
    else {
      if (mode.reuse) args.push("--reuse");
      if (mode.gif) args.push("--gif");
    }
  }
  const proc: ChildProcess = spawn(cli.command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const est = estimateFor(name);
  if (mode.preview) est.render = Math.min(est.render, 12);
  if (mode.renderOnly) est.capture = 0;
  const run: Run = { proc, lines: [], done: false, code: null, listeners: new Set(), stage: mode.renderOnly ? "render" : "starting", startedAt: Date.now(), stageAt: Date.now(), estimate: est };
  const push = (chunk: Buffer) => {
    for (const raw of chunk.toString().split("\n")) {
      const l = raw.trimEnd();
      if (!l || /^\$ ffmpeg|zoom filter|filter graph|^>/.test(l)) continue;
      const st = /^\[stage\] (\w+)(?: (\w+))?/.exec(l);
      if (st) {
        run.stage = st[2] === "skip" ? `${st[1]}-skip` : st[1];
        run.stageAt = Date.now();
        for (const res of run.listeners) res.write(`event: stage\ndata: ${JSON.stringify({ stage: run.stage, at: run.stageAt, estimate: run.estimate })}\n\n`);
        continue;
      }
      run.lines.push(l);
      for (const res of run.listeners) res.write(`data: ${JSON.stringify(l)}\n\n`);
    }
  };
  proc.stdout?.on("data", push);
  proc.stderr?.on("data", push);
  proc.on("close", (code) => {
    run.done = true;
    run.code = code;
    for (const res of run.listeners) {
      res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`);
      res.end();
    }
    run.listeners.clear();
  });
  runs.set(name, run);
  return run;
}

/** Read/write the .env in the project root — only the keys we own. */
function writeEnv(set: Record<string, string | undefined>) { writeEnvFile(ROOT, set); }
function envSummary() {
  return { localUrl: process.env.RETAKE_LOCAL_URL ?? "", localModel: process.env.RETAKE_LOCAL_MODEL ?? "", groq: !!process.env.GROQ_API_KEY, mistral: !!process.env.MISTRAL_API_KEY };
}
function modelSelection() {
  return { claude: process.env.RETAKE_CLAUDE_MODEL ?? "", codex: process.env.RETAKE_CODEX_MODEL ?? "", codexReasoning: process.env.RETAKE_CODEX_REASONING ?? "", groq: process.env.RETAKE_GROQ_MODEL ?? "", mistral: process.env.RETAKE_MISTRAL_MODEL ?? "", local: process.env.RETAKE_LOCAL_MODEL ?? "" };
}

/** A navigation error, said the way a person would say it. */
function unreachable(url: string, e: Error): string {
  const m = e.message;
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(m)) {
    const want = Number(new URL(url).port || 80);
    const others = listeningPorts().filter((pt) => pt !== want && pt !== 4310);
    const hint = others.length ? ` Things are running on ${others.slice(0, 6).map((pt) => ":" + pt).join(", ")} — one of those?` : "";
    return `Nothing is running at ${url}.${hint}`;
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(m)) return `Could not find ${new URL(url).host}. Check the address.`;
  if (/Timeout/.test(m)) return `${url} did not finish loading in time. Is it up?`;
  return m.split("\n")[0];
}

/** Native folder selection for the local UI. Browsers intentionally hide an
    absolute path, but Retake needs one so its operator can read the app. */
function pickFolder(): Promise<string | null> {
  return new Promise((done, fail) => {
    let command: string, args: string[];
    if (process.platform === "darwin") {
      command = "osascript";
      args = ["-e", "POSIX path of (choose folder with prompt \"Choose the app Retake should record\")"];
    } else if (process.platform === "win32") {
      command = "powershell";
      args = ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq 'OK'){$d.SelectedPath}"];
    } else {
      command = "zenity";
      args = ["--file-selection", "--directory", "--title=Choose the app Retake should record"];
    }
    execFile(command, args, { encoding: "utf8", maxBuffer: 64_000 }, (error, stdout) => {
      if (error) {
        // Native pickers use a non-zero exit when the person cancels.
        if (String((error as { code?: string | number }).code) === "1") return done(null);
        return fail(error);
      }
      done(stdout.trim().replace(/\/$/, "") || null);
    });
  });
}

const BOOT = Date.now();   // pages compare this and reload themselves after a restart

/** A live view of agent-driven work, so the app is a window and not a folder. */
type Activity = { active: boolean; who: string; demo?: string; lines: string[]; startedAt: number; finishedAt?: number };
const activity: Activity = { active: false, who: "", lines: [], startedAt: 0 };
const activityWatchers = new Set<(ev: { type: string; data: unknown }) => void>();

/** An agent that stops reporting without calling done would otherwise look
    busy forever; ten quiet minutes means it is gone. */
function withStaleness(a: Activity): Activity & { stale?: boolean } {
  const last = a.lines.length ? a.startedAt : 0;
  if (a.active && Date.now() - Math.max(last, a.startedAt) > 10 * 60_000 && !a.lines.length) return { ...a, active: false, stale: true };
  return a;
}

/** An agent asking for credentials BY NAME. The window collects the values
    and they go straight into .env here — the agent only ever learns "set". */
type SecretRequest = { id: string; names: string[]; why: string; filled: boolean; at: number };
const secretRequests = new Map<string, SecretRequest>();
const openSecretRequests = () => [...secretRequests.values()].filter((r) => !r.filled).map(({ id, names, why }) => ({ id, names, why }));

function noteActivity(b: { line?: string; demo?: string; done?: boolean; who?: string }) {
  if (!activity.active && !b.done) { activity.active = true; activity.startedAt = Date.now(); activity.lines = []; activity.finishedAt = undefined; }
  if (b.who) activity.who = b.who;
  if (b.demo) activity.demo = b.demo;
  if (b.line) { activity.lines.push(b.line); if (activity.lines.length > 200) activity.lines.shift(); }
  if (b.done) { activity.active = false; activity.finishedAt = Date.now(); }
  for (const w of activityWatchers) w({ type: b.done ? "finished" : "line", data: { ...activity, latest: b.line } });
}

export function serve(port: number) {
  loadDotenv(ROOT);
  const page = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
  const chatPage = fs.readFileSync(path.join(HERE, "chat.html"), "utf8");
  const guidePage = fs.readFileSync(path.join(HERE, "guide.html"), "utf8");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname;
      if (p === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(chatPage);
      }
      if (p === "/landing" && req.method === "GET") {
        const f = path.join(PKG_ROOT, "site", "index.html");
        if (!fs.existsSync(f)) return json(res, 404, { error: "no site/index.html" });
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(fs.readFileSync(f));
      }
      // Both prefixes: the page is served at /landing here and from a site
      // root when deployed, so its asset paths are relative either way.
      const msite = /^(?:\/landing)?\/(media|logos)\/([A-Za-z0-9._-]+)$/.exec(p);
      if (msite && (req.method === "GET" || req.method === "HEAD")) {
        const f = path.join(PKG_ROOT, "site", msite[1], msite[2]);
        if (!fs.existsSync(f)) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": MIME[path.extname(f)] ?? "application/octet-stream", "content-length": fs.statSync(f).size });
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(f).pipe(res);
      }
      if (p === "/guide" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(guidePage);
      }
      if (p === "/classic" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(page);
      }
      if (p === "/manifest.webmanifest") {
        res.writeHead(200, { "content-type": "application/manifest+json" });
        return res.end(JSON.stringify({ name: "Retake", short_name: "Retake", description: "Rerun the demo, don't re-record it.", start_url: "/", scope: "/", display: "standalone", background_color: "#edefe8", theme_color: "#edefe8", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }] }));
      }
      if (p === "/sw.js") {
        res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
        // Network-first, tiny: the app is local; the SW exists so the browser offers "Install".
        return res.end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).pathname.startsWith('/api/'))return;e.respondWith(fetch(e.request).catch(()=>caches.match(e.request)))});`);
      }
      const ic = /^\/icon-(192|512)\.png$/.exec(p);
      if (ic) {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" });
        return res.end(fs.readFileSync(path.join(PKG_ROOT, "assets", `icon-${ic[1]}.png`)));
      }
      if (p === "/favicon.svg") {
        const f = path.join(PKG_ROOT, "assets", "logo.svg");
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
        return res.end(fs.readFileSync(f));
      }
      if (p === "/api/demos" && req.method === "GET") return json(res, 200, listDemos(url.searchParams.get("project") ?? undefined));
      const mproject = /^\/api\/demos\/([a-z0-9-]+)\/project$/.exec(p);
      if (mproject && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { project: string };
        if (!b.project?.trim()) return json(res, 400, { error: "project folder is required" });
        if (!fs.existsSync(path.join(DEMOS, `${mproject[1]}.yaml`))) return json(res, 404, { error: "demo not found" });
        assignDemoProject(mproject[1], b.project);
        return json(res, 200, { ok: true, name: mproject[1], project: projectKey(b.project) });
      }
      if (p === "/api/pick-folder" && req.method === "POST") {
        try { return json(res, 200, { dir: await pickFolder() }); }
        catch (e) { return json(res, 500, { error: `Could not open the folder picker: ${(e as Error).message}` }); }
      }
      if (p === "/api/provider" && req.method === "GET") return json(res, 200, providerStatus());
      if (p === "/api/presets" && req.method === "GET") return json(res, 200, Object.values(PRESETS));
      if (p === "/api/drafts" && req.method === "GET") return json(res, 200, listDrafts());
      const md = /^\/api\/drafts\/([a-z0-9-]+)$/.exec(p);
      if (md) {
        const file = path.join(DRAFTS, `${md[1]}.json`);
        if (req.method === "GET") return fs.existsSync(file) ? json(res, 200, JSON.parse(fs.readFileSync(file, "utf8"))) : json(res, 404, { error: "no such draft" });
        if (req.method === "PUT") {
          const b = JSON.parse(await readBody(req)) as Partial<Draft>;
          fs.mkdirSync(DRAFTS, { recursive: true });
          const prev: Partial<Draft> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
          const d: Draft = { id: md[1], name: b.name || prev.name || nextProjectName(), url: b.url ?? prev.url ?? "", project: b.project ?? prev.project ?? "", describe: b.describe ?? prev.describe ?? "", step: b.step ?? prev.step ?? 1, updated: new Date().toISOString() };
          fs.writeFileSync(file, JSON.stringify(d, null, 2));
          return json(res, 200, d);
        }
        if (req.method === "DELETE") { fs.rmSync(file, { force: true }); return json(res, 200, { ok: true }); }
      }
      if (p === "/api/trash" && req.method === "GET") {
        const trash = path.join(ROOT, ".trash");
        const items = fs.existsSync(trash) ? fs.readdirSync(trash).filter((f) => f.endsWith(".yaml")).map((f) => { const m = /^(.+)\.(\d+)\.yaml$/.exec(f); return m ? { name: m[1], at: Number(m[2]) } : null; }).filter((x): x is { name: string; at: number } => !!x).sort((a, b) => b.at - a.at) : [];
        // one row per name — the newest is what restore would bring back
        const seen = new Set<string>();
        return json(res, 200, items.filter((x) => !seen.has(x.name) && seen.add(x.name)));
      }
      // ---------- the poster: any frame, a card, or their own file ----------
      // thumbnail.png IS the poster. Every source here just writes it, so the
      // choice costs no re-render and never touches the video.
      const mcov = /^\/api\/cover\/([a-z0-9-]+)$/.exec(p);
      if (mcov && req.method === "POST") {
        const name = mcov[1];
        const dir = path.join(outRoot(), name);
        const target = path.join(dir, "thumbnail.png");
        if (!fs.existsSync(dir)) return json(res, 404, { error: `no take for ${name}` });
        const b = JSON.parse(await readBody(req)) as { still?: string; at?: number; file?: string; dataUrl?: string };
        try {
          if (b.still) {
            // A scene still, by its file name under stills/.
            const src = path.join(dir, "stills", path.basename(b.still));
            if (!fs.existsSync(src)) return json(res, 404, { error: `no still ${b.still}` });
            fs.copyFileSync(src, target);
          } else if (b.file) {
            // A candidate already in the take (cover.png, cover-titled.png).
            const src = path.join(dir, path.basename(b.file));
            if (!fs.existsSync(src)) return json(res, 404, { error: `no file ${b.file}` });
            fs.copyFileSync(src, target);
          } else if (typeof b.at === "number") {
            // Any moment of the finished video — usually the best frame is
            // nowhere near a scene marker.
            const mp4 = path.join(dir, "demo.mp4");
            if (!fs.existsSync(mp4)) return json(res, 404, { error: "no demo.mp4" });
            execFileSync(ffmpegBin(), ["-y", "-loglevel", "error", "-ss", Math.max(0, b.at).toFixed(2), "-i", mp4, "-frames:v", "1", target]);
          } else if (b.dataUrl) {
            // Their own image.
            const m2 = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(b.dataUrl);
            if (!m2) return json(res, 400, { error: "expected a png, jpeg or webp data URL" });
            fs.writeFileSync(target, Buffer.from(m2[2], "base64"));
          } else return json(res, 400, { error: "give a still, a file, an `at` time, or a dataUrl" });
        } catch (e) {
          return json(res, 500, { error: (e as Error).message });
        }
        return json(res, 200, { ok: true, poster: "thumbnail.png" });
      }

      if (p === "/api/trash/clear" && req.method === "POST") {
        const trash = path.join(ROOT, ".trash");
        let n = 0;
        if (fs.existsSync(trash)) for (const f of fs.readdirSync(trash)) if (f.endsWith(".yaml")) { fs.rmSync(path.join(trash, f), { force: true }); n++; }
        return json(res, 200, { ok: true, cleared: n });
      }
      const mres = /^\/api\/demos\/([a-z0-9-]+)\/restore$/.exec(p);
      if (mres && req.method === "POST") {
        // Bring back the most recent trashed manifest with this name.
        const trash = path.join(ROOT, ".trash");
        const cands = fs.existsSync(trash) ? fs.readdirSync(trash).filter((f) => f.startsWith(mres[1] + ".") && f.endsWith(".yaml")).sort() : [];
        if (!cands.length) return json(res, 404, { error: "nothing to restore" });
        const from = path.join(trash, cands[cands.length - 1]);
        fs.mkdirSync(DEMOS, { recursive: true });
        fs.renameSync(from, path.join(DEMOS, `${mres[1]}.yaml`));
        return json(res, 200, { ok: true, name: mres[1] });
      }
      const mdel = /^\/api\/demos\/([a-z0-9-]+)$/.exec(p);
      if (mdel && req.method === "DELETE") {
        const file = path.join(DEMOS, `${mdel[1]}.yaml`);
        const out = path.join(outRoot(), mdel[1]);
        if (fs.existsSync(path.join(out, ".retake-lock"))) return json(res, 409, { error: "a run is using this demo right now — wait for it to finish" });
        // Never delete silently: the manifest goes to .trash/ with a timestamp so a slip is recoverable.
        const trash = path.join(ROOT, ".trash");
        fs.mkdirSync(trash, { recursive: true });
        if (fs.existsSync(file)) fs.renameSync(file, path.join(trash, `${mdel[1]}.${Date.now()}.yaml`));
        if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
        unassignDemoProject(mdel[1]);
        return json(res, 200, { ok: true });
      }
      const mg = /^\/api\/gif\/([a-z0-9-]+)$/.exec(p);
      if (mg && req.method === "POST") {
        const out = makeGif(path.join(outRoot(), mg[1]));
        return json(res, 200, { file: path.basename(out), size: fs.statSync(out).size });
      }
      // "Tell Retake what to change": plain English → structured edits → re-render or re-record.
      const mfix = /^\/api\/fix\/([a-z0-9-]+)$/.exec(p);
      if (mfix && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { instruction: string; run?: boolean };
        const file = path.join(DEMOS, `${mfix[1]}.yaml`);
        if (!fs.existsSync(file)) return json(res, 404, { error: "not found" });
        const provider = pickProvider();
        if (!provider) return json(res, 400, { error: "no model configured — pick one in Settings" });
        const m = loadManifest(file).manifest;
        const takePath = path.join(outRoot(), mfix[1], "take.json");
        const take = fs.existsSync(takePath) ? (JSON.parse(fs.readFileSync(takePath, "utf8")) as import("../record.js").Take) : null;
        const receipts = receiptsFor(take, m.steps as never);
        const { edits, note } = await proposeEdits({ instruction: b.instruction, yaml: fs.readFileSync(file, "utf8"), receipts, provider });
        if (!edits.length) return json(res, 200, { applied: [], skipped: [], note: note || "Nothing to change for that.", rerecord: false });
        const a = applyEdits(file, edits);
        const m2 = loadManifest(file).manifest;
        const rerecord = a.rerecord || !take || !take.captureHash || take.captureHash !== captureHash(m2);
        return json(res, 200, { applied: a.done, skipped: a.skipped, note, rerecord, yaml: a.yaml });
      }

      // "Take it from here": scout → (read project) → draft → dry-run → repair → fast preview.
      if (p === "/api/create" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { url: string; describe: string; project?: string; name?: string };
        if (!/^https?:\/\//.test(b.url)) return json(res, 400, { error: "url must start with http(s)://" });
        if (!b.describe?.trim()) return json(res, 400, { error: "say what the demo should show" });
        const provider = pickProvider();
        if (!provider) return json(res, 400, { error: "no model configured — pick one in Settings" });
        const name = b.name && safeName(b.name) ? b.name : nextProjectName();
        const file = path.join(DEMOS, `${name}.yaml`);
        if (fs.existsSync(file)) return json(res, 409, { error: `"${name}" already exists` });
        const run: Run = { proc: null, lines: [], done: false, code: null, listeners: new Set(), stage: "scouting", startedAt: Date.now(), stageAt: Date.now(), estimate: { capture: 90, render: 12 } };
        runs.set(name, run);
        const project = b.project ? b.project.replace(/^~/, os.homedir()).trim() : undefined;
        (async () => {
          try {
            setStage(run, "scouting");
            let sc: Scout;
            try { sc = await scout(b.url); } catch (e) { emit(run, `✗ ${unreachable(b.url, e as Error)}`); if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test((e as Error).message)) emit(run, "__DOWN__"); return finish(run, 2); }
            emit(run, `Found the page — ${sc.elements.length} controls${sc.headings.length ? `, “${sc.headings[0]}”` : ""}`);
            if (project) { try { const d = digest(project); emit(run, `Read ${d.name}: ${d.files} files, ${d.routes.length} routes, ${d.selectors.length} stable selectors`); } catch (e) { emit(run, `Could not read ${project}: ${(e as Error).message}`); } }
            setStage(run, "drafting");
            emit(run, `Drafting with ${provider.name}…`);
            const d = await draftManifest({ name, url: b.url, describe: b.describe, scout: sc, provider, project, demosDir: DEMOS });
            fs.mkdirSync(DEMOS, { recursive: true });
            fs.writeFileSync(file, d.yaml);
            if (project) assignDemoProject(name, project);
            const m = loadManifest(file).manifest;
            emit(run, `Drafted ${m.steps.length} steps, ${m.steps.filter((s) => s.action === "scene").length} scenes`);
            setStage(run, "checking");
            let r = await dryRun(m, DEMOS, () => {});
            if (!r.ok) {
              const rep = autoRepair(fs.readFileSync(file, "utf8"), r.lines);
              if (rep.fixes.length) { fs.writeFileSync(file, rep.yaml); for (const f of rep.fixes) emit(run, `Fixed ${f}`); r = await dryRun(loadManifest(file).manifest, DEMOS, () => {}); }
            }
            if (!r.ok) {
              // One model pass with the evidence, then stop and show the person.
              emit(run, `${r.failures} step(s) would fail — asking ${provider.name} to repair…`);
              const m1 = loadManifest(file).manifest;
              const { edits, note } = await proposeEdits({ instruction: "These steps fail in a dry run. Repair them (usually a different selector, or a wait for something to appear). Failures:\n" + r.lines.join("\n"), yaml: fs.readFileSync(file, "utf8"), receipts: receiptsFor(null, m1.steps as never), provider });
              if (edits.length) { const a = applyEdits(file, edits); for (const x of a.done) emit(run, `Fixed: ${x}`); r = await dryRun(loadManifest(file).manifest, DEMOS, () => {}); }
              else emit(run, note || "No repair proposed.");
            }
            if (!r.ok) { for (const l of r.lines.slice(0, 6)) emit(run, l); emit(run, `✗ Still ${r.failures} step(s) that would fail — open Advanced to fix them, then press Record.`); return finish(run, 3); }
            emit(run, `Checked: all ${m.steps.length} steps resolve on the page`);
            setStage(run, "capture");
            emit(run, "Recording a fast preview…");
            const child = spawn(entry("cli").command, [...entry("cli").args, "run", file, "--preset", "preview-fast", "--out", outRoot()], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
            run.proc = child;
            const push = (chunk: Buffer) => { for (const raw of chunk.toString().split("\n")) { const l = raw.trimEnd(); if (!l || /^\$ ffmpeg|zoom filter|filter graph|^>/.test(l)) continue; const st = /^\[stage\] (\w+)/.exec(l); if (st) { setStage(run, st[1] === "done" ? "done" : st[1]); continue; } emit(run, l); } };
            child.stdout.on("data", push); child.stderr.on("data", push);
            child.on("close", (code) => finish(run, code ?? 1));
          } catch (e) {
            emit(run, `✗ ${(e as Error).message.split("\n")[0]}`);
            finish(run, 1);
          }
        })();
        return json(res, 200, { name, startedAt: run.startedAt, estimate: run.estimate });
      }

      // ---------- what somebody else's agent is doing right now ----------
      // Claude Code or Codex can drive Retake over MCP from their own window.
      // Without this, the app shows nothing until a file lands — so the tools
      // report here, and the page watches, and the person can see the work.
      if (p === "/api/activity" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { line?: string; demo?: string; done?: boolean; who?: string };
        noteActivity(b);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/activity" && req.method === "GET") return json(res, 200, withStaleness(activity));

      // ---------- secrets: asked for by name, typed into the window, written here ----------
      if (p === "/api/secrets/request" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { names?: string[]; why?: string };
        const names = (b.names ?? []).filter((n) => SECRET_NAME.test(n));
        if (!names.length) return json(res, 400, { error: "names must be like APP_PASSWORD" });
        // The same ask twice is one form, not two stacked ones.
        const dup = [...secretRequests.values()].find((x) => !x.filled && x.names.join() === names.join());
        if (dup) return json(res, 200, { id: dup.id });
        const r: SecretRequest = { id: "s" + Date.now().toString(36), names, why: String(b.why ?? "").slice(0, 300), filled: false, at: Date.now() };
        secretRequests.set(r.id, r);
        for (const w of activityWatchers) w({ type: "secrets", data: { id: r.id, names: r.names, why: r.why } });
        return json(res, 200, { id: r.id });
      }
      if (p === "/api/secrets/pending" && req.method === "GET") return json(res, 200, openSecretRequests());
      if (p === "/api/secrets/fill" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { id: string; values?: Record<string, string> };
        const r = secretRequests.get(b.id);
        if (!r) return json(res, 404, { error: "no such request" });
        const values: Record<string, string> = {};
        for (const [k, v] of Object.entries(b.values ?? {})) if (r.names.includes(k) && typeof v === "string" && v.trim()) values[k] = v;
        if (!Object.keys(values).length) return json(res, 400, { error: "nothing to save" });
        writeEnvFile(ROOT, values);
        if (!missingSecrets(ROOT, r.names).length) r.filled = true;
        for (const w of activityWatchers) w({ type: "secrets-done", data: { id: r.id, filled: r.filled } });
        return json(res, 200, { ok: true, filled: r.filled, set: Object.keys(values) });
      }
      const msec = /^\/api\/secrets\/(s[a-z0-9]+)$/.exec(p);
      if (msec && req.method === "GET") {
        const r = secretRequests.get(msec[1]);
        return r ? json(res, 200, { filled: r.filled, missing: missingSecrets(ROOT, r.names) }) : json(res, 404, { error: "no such request" });
      }
      if (p === "/api/activity/stream" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: state\ndata: ${JSON.stringify({ ...activity, boot: BOOT, secrets: openSecretRequests() })}\n\n`);
        const send = (ev: { type: string; data: unknown }) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
        activityWatchers.add(send);
        const beat = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => { activityWatchers.delete(send); clearInterval(beat); });
        return;
      }

      // ---------- the operator: the coding agent drives Retake, fenced to its tools ----------
      if (p === "/api/operator" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { describe: string; url?: string; project?: string; name?: string };
        if (!b.describe?.trim()) return json(res, 400, { error: "say what the demo should show" });
        const prov = pickProvider();
        const which = prov?.name === "codex" ? "codex" : prov?.name === "claude-code" ? "claude-code" : null;
        if (!which) return json(res, 400, { error: "The operator needs Claude Code or Codex (Settings). With another model, use “Take it from here” — same result, fixed steps." });
        const ui = `http://localhost:${(req.socket.localPort as number) || 4310}`;
        const project = b.project ? b.project.replace(/^~/, os.homedir()).trim() : undefined;
        const s = startOperator({ describe: b.describe, url: b.url?.trim() || undefined, project, name: b.name && safeName(b.name) ? b.name : undefined, ui, root: ROOT, provider: which, onDemo: (demo) => { if (project && safeName(demo)) assignDemoProject(demo, project); } });
        return json(res, 200, { id: s.id, startedAt: s.startedAt, provider: which });
      }
      const mop = /^\/api\/operator\/([a-z0-9]+)(?:\/(log|pending|done|stream|stop|answer)(?:\/([a-z0-9]+))?)?$/.exec(p);
      if (mop) {
        const s = getSession(mop[1]);
        if (!s) return json(res, 404, { error: "no such session" });
        const sub = mop[2];
        if (sub === "log" && req.method === "POST") { const b = JSON.parse(await readBody(req)) as { line: string }; s.lines.push(b.line); for (const l of s.listeners) l({ type: "line", data: b.line }); return json(res, 200, { ok: true }); }
        if (sub === "pending" && req.method === "POST") { const b = JSON.parse(await readBody(req)) as { kind: "question" | "approve"; text: string; detail?: string }; const pnd = addPending(s, b.kind, b.text, b.detail); return json(res, 200, { id: pnd.id }); }
        if (sub === "pending" && req.method === "GET" && mop[3]) { const pnd = s.pending.find((x) => x.id === mop[3]); return pnd ? json(res, 200, { answered: pnd.answered, answer: pnd.answer }) : json(res, 404, { error: "no such question" }); }
        if (sub === "answer" && req.method === "POST") { const b = JSON.parse(await readBody(req)) as { id: string; answer: string }; return json(res, answerPending(s, b.id, b.answer) ? 200 : 404, { ok: true }); }
        if (sub === "done" && req.method === "POST") { const b = JSON.parse(await readBody(req)) as { summary: string; demo?: string }; markDone(s, b.summary, b.demo); return json(res, 200, { ok: true }); }
        if (sub === "stop" && req.method === "POST") { stopSession(s); return json(res, 200, { ok: true }); }
        if (sub === "stream" && req.method === "GET") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
          const send = (ev: { type: string; data: unknown }) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
          for (const l of s.lines) send({ type: "line", data: l });
          for (const pnd of s.pending.filter((x) => !x.answered)) send({ type: "pending", data: pnd });
          if (s.done) { send({ type: "done", data: { code: s.code, summary: s.summary, demo: s.demo, cost: s.cost, turns: s.turns } }); return res.end(); }
          s.listeners.add(send);
          req.on("close", () => s.listeners.delete(send));
          return;
        }
        if (!sub && req.method === "GET") return json(res, 200, { id: s.id, done: s.done, code: s.code, summary: s.summary, demo: s.demo, pending: s.pending.filter((x) => !x.answered), lines: s.lines.slice(-40), cost: s.cost, turns: s.turns });
      }

      if (p === "/api/ideas" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { url: string; project?: string };
        if (!/^https?:\/\//.test(b.url)) return json(res, 400, { error: "url must start with http(s)://" });
        const provider = pickProvider();
        if (!provider) return json(res, 400, { error: "no model configured — pick one in Settings" });
        let sc;
        try { sc = await scout(b.url); } catch (e) { const m = (e as Error).message; return json(res, 400, { error: unreachable(b.url, e as Error), down: /ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(m) }); }
        const project = b.project ? b.project.replace(/^~/, os.homedir()).trim() : undefined;
        const { markdown, ideas } = await suggestIdeas({ url: b.url, scout: sc, provider, project });
        const file = path.join(ROOT, "ideas", `${new URL(b.url).host.replace(/[^a-z0-9]+/gi, "-")}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# Demo ideas — ${b.url}\n\n_Suggested by ${provider.name} (${provider.model})${project ? ` after reading ${project}` : ""}._\n\n${markdown}\n`);
        return json(res, 200, { ideas, file: path.relative(ROOT, file) });
      }
      if (p === "/api/start" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { dir: string; command?: string; url?: string };
        const off = startOffer(b.dir);
        const command = b.command?.trim() || off?.command;
        if (!command) return json(res, 400, { error: "No dev, start, serve, or preview script was found. Add a running app URL instead." });
        const r = await startApp({ dir: b.dir, command, expectUrl: b.url });
        return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, url: r.url, pid: r.pid } : { error: r.why ?? "could not start", log: r.log.slice(-1200) });
      }
      if (p === "/api/project" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { dir: string };
        const dir = b.dir.replace(/^~/, os.homedir()).trim();
        try {
          const d = digest(dir);
          const off = startOffer(dir);
          return json(res, 200, { ok: true, dir: d.dir, name: d.name, stack: d.stack, files: d.files, routes: d.routes.slice(0, 12), selectors: d.selectors.length, auth: d.auth.length > 0, flaky: d.flaky.length, start: off });
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
      }
      if (p === "/api/models" && req.method === "GET") {
        const provider = url.searchParams.get("provider") || pickProvider()?.name;
        if (provider === "codex") {
          try {
            const raw = execFileSync("codex", ["debug", "models", "--bundled"], { encoding: "utf8", timeout: 15_000, maxBuffer: 4e6 });
            const catalog = JSON.parse(raw) as { models?: { slug: string; display_name?: string; visibility?: string; default_reasoning_level?: string; supported_reasoning_levels?: { effort: string; description?: string }[] }[] };
            return json(res, 200, { provider, selected: process.env.RETAKE_CODEX_MODEL ?? "", reasoning: process.env.RETAKE_CODEX_REASONING ?? "", models: (catalog.models ?? []).filter((m) => m.visibility === "list").map((m) => ({ id: m.slug, name: m.display_name || m.slug, defaultReasoning: m.default_reasoning_level, reasoning: m.supported_reasoning_levels ?? [] })) });
          } catch (e) { return json(res, 500, { error: `Could not read Codex models: ${(e as Error).message}` }); }
        }
        if (provider === "claude-code") return json(res, 200, { provider, selected: process.env.RETAKE_CLAUDE_MODEL ?? "", models: [{ id: "", name: "Recommended" }, { id: "sonnet", name: "Sonnet" }, { id: "opus", name: "Opus" }, { id: "haiku", name: "Haiku" }] });
        const key = provider === "groq" ? "RETAKE_GROQ_MODEL" : provider === "mistral" ? "RETAKE_MISTRAL_MODEL" : "RETAKE_LOCAL_MODEL";
        const selected = process.env[key] ?? "";
        return json(res, 200, { provider, selected, models: [{ id: selected, name: selected || "Configured default" }] });
      }
      if (p === "/api/settings" && req.method === "GET") return json(res, 200, { envPath: path.join(ROOT, ".env"), ...providerStatus(), model: process.env.RETAKE_MODEL ?? "", selection: modelSelection(), gifski: !!gifskiBin(), env: envSummary(), outDir: outRoot(), outDefault: OUT_DEFAULT, version: VERSION });
      const mopen = /^\/api\/open\/([a-z0-9-]+)$/.exec(p);
      if (mopen && req.method === "POST") {
        const dir = path.join(outRoot(), mopen[1]);
        if (!fs.existsSync(dir)) return json(res, 404, { error: "no outputs yet" });
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
        try { spawn(opener, [dir], { stdio: "ignore", detached: true }).unref(); } catch (e) { return json(res, 500, { error: (e as Error).message }); }
        return json(res, 200, { ok: true, dir });
      }
      if (p === "/api/settings" && req.method === "PUT") {
        const b = JSON.parse(await readBody(req)) as { model?: string; localUrl?: string; localModel?: string; claudeModel?: string; codexModel?: string; codexReasoning?: string; groqModel?: string; mistralModel?: string; groqKey?: string; mistralKey?: string; outDir?: string };
        if (b.outDir !== undefined && b.outDir.trim()) {
          const d = path.resolve(b.outDir.trim().replace(/^~/, os.homedir()));
          try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); } catch { return json(res, 400, { error: `Can't write to ${d}` }); }
        }
        const set: Record<string, string | undefined> = { RETAKE_MODEL: b.model, RETAKE_LOCAL_URL: b.localUrl, RETAKE_LOCAL_MODEL: b.localModel, RETAKE_CLAUDE_MODEL: b.claudeModel, RETAKE_CODEX_MODEL: b.codexModel, RETAKE_CODEX_REASONING: b.codexReasoning, RETAKE_GROQ_MODEL: b.groqModel, RETAKE_MISTRAL_MODEL: b.mistralModel, GROQ_API_KEY: b.groqKey, MISTRAL_API_KEY: b.mistralKey, RETAKE_OUT: b.outDir === undefined ? undefined : b.outDir.trim() };
        writeEnv(set);
        for (const [k, v] of Object.entries(set)) if (v !== undefined) { if (v === "") delete process.env[k]; else process.env[k] = v; }
        return json(res, 200, { ...providerStatus(), model: process.env.RETAKE_MODEL ?? "", selection: modelSelection(), env: envSummary(), outDir: outRoot(), outDefault: OUT_DEFAULT });
      }
      const ms = /^\/api\/demos\/([a-z0-9-]+)\/settings$/.exec(p);
      if (ms && req.method === "PATCH") {
        const file = path.join(DEMOS, `${ms[1]}.yaml`);
        if (!fs.existsSync(file)) return json(res, 404, { error: "not found" });
        const b = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
        for (const k of ["preset", "layout", "camera", "cursor", "title", "tempo"]) {
          if (!(k in b)) continue;
          if (b[k] === null || b[k] === "" || b[k] === "default") doc.delete(k);
          else doc.set(k, b[k]);
        }
        const text = doc.toString();
        const parsed = Manifest.safeParse(YAML.parse(text));
        if (!parsed.success) return json(res, 400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n") });
        fs.writeFileSync(file, text);
        return json(res, 200, { ok: true, yaml: text });
      }
      if (p === "/api/describe" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { name: string; url: string; describe: string; project?: string };
        if (!b.name) b.name = nextProjectName();
        if (!safeName(b.name)) return json(res, 400, { error: "name must be kebab-case" });
        if (!/^https?:\/\//.test(b.url)) return json(res, 400, { error: "url must start with http(s)://" });
        if (!b.describe?.trim()) return json(res, 400, { error: "describe what to record" });
        const file = path.join(DEMOS, `${b.name}.yaml`);
        if (fs.existsSync(file)) return json(res, 409, { error: "a demo with that name exists" });
        const provider = pickProvider();
        if (!provider) return json(res, 400, { error: "no model configured — set GROQ_API_KEY, MISTRAL_API_KEY, or RETAKE_LOCAL_URL (see README)" });
        let sc;
        try { sc = await scout(b.url); } catch (e) { const m = (e as Error).message; return json(res, 400, { error: unreachable(b.url, e as Error), down: /ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(m) }); }
        const project = b.project ? b.project.replace(/^~/, os.homedir()).trim() : undefined;
        const d = await draftManifest({ name: b.name, url: b.url, describe: b.describe, scout: sc, provider, project, demosDir: DEMOS });
        fs.mkdirSync(DEMOS, { recursive: true });
        fs.writeFileSync(file, d.yaml);
        if (project) assignDemoProject(b.name, project);
        return json(res, 200, { name: b.name, provider: d.provider, retried: d.retried, scouted: sc.elements.length, read: d.digest ? d.digest.files : 0 });
      }
      if (p === "/api/demos" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { name: string; url: string; describe: string; project?: string };
        if (!b.name) b.name = nextProjectName();
        if (!safeName(b.name)) return json(res, 400, { error: "name must be kebab-case" });
        const file = path.join(DEMOS, `${b.name}.yaml`);
        if (fs.existsSync(file)) return json(res, 409, { error: "a demo with that name exists" });
        fs.mkdirSync(DEMOS, { recursive: true });
        fs.writeFileSync(file, starterManifest(b.name, b.url, b.describe ?? ""));
        if (b.project) assignDemoProject(b.name, b.project);
        return json(res, 200, { name: b.name });
      }
      let m = /^\/api\/demos\/([a-z0-9-]+)$/.exec(p);
      if (m) {
        const file = path.join(DEMOS, `${m[1]}.yaml`);
        if (req.method === "GET") {
          if (!fs.existsSync(file)) return json(res, 404, { error: "not found" });
          return json(res, 200, { yaml: fs.readFileSync(file, "utf8") });
        }
        if (req.method === "PUT") {
          const b = JSON.parse(await readBody(req)) as { yaml: string };
          const parsed = Manifest.safeParse(YAML.parse(b.yaml));
          if (!parsed.success) return json(res, 400, { error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n") });
          if (parsed.data.name !== m[1]) return json(res, 400, { error: `name in yaml (${parsed.data.name}) must match ${m[1]}` });
          fs.writeFileSync(file, b.yaml);
          return json(res, 200, { ok: true, steps: parsed.data.steps.length, scenes: parsed.data.steps.filter((s) => s.action === "scene").length });
        }
      }
      const msc = /^\/api\/demos\/([a-z0-9-]+)\/(scene|trim)$/.exec(p);
      if (msc && req.method === "PATCH") {
        const file = path.join(DEMOS, `${msc[1]}.yaml`);
        if (!fs.existsSync(file)) return json(res, 404, { error: "not found" });
        const b = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
        if (msc[2] === "trim") {
          const head = Number(b.head ?? 0), tail = Number(b.tail ?? 0);
          if (!head && !tail) doc.delete("trim");
          else doc.set("trim", { head: Math.max(0, Math.round(head * 100) / 100), tail: Math.max(0, Math.round(tail * 100) / 100) });
        } else {
          const steps = doc.get("steps") as YAML.YAMLSeq | undefined;
          const node = steps?.items.find((it) => {
            const n = it as YAML.YAMLMap;
            return typeof n.get === "function" && n.get("action") === "scene" && n.get("label") === b.label;
          }) as YAML.YAMLMap | undefined;
          if (!node) return json(res, 404, { error: `scene "${b.label}" not found` });
          if (b.caption !== undefined) { if (b.caption === "") node.delete("caption"); else node.set("caption", b.caption); }
          if (b.holdMs !== undefined) { if (!b.holdMs) node.delete("holdMs"); else node.set("holdMs", Number(b.holdMs)); }
          if (b.camera !== undefined) {
            if (b.camera === "static") node.set("camera", "static");
            else if (b.camera === "auto") node.set("camera", "auto");
            else if (typeof b.camera === "object") node.set("camera", b.camera);
          }
        }
        const text = doc.toString();
        const parsed = Manifest.safeParse(YAML.parse(text));
        if (!parsed.success) return json(res, 400, { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n") });
        fs.writeFileSync(file, text);
        return json(res, 200, { ok: true, yaml: text });
      }

      m = /^\/api\/run\/([a-z0-9-]+)$/.exec(p);
      if (m && req.method === "POST") {
        const lock = path.join(outRoot(), m[1], ".retake-lock");
        const existing = runs.get(m[1]);
        if ((!existing || existing.done) && fs.existsSync(lock)) {
          const pid = Number(fs.readFileSync(lock, "utf8"));
          try { process.kill(pid, 0); return json(res, 409, { error: `a run from the terminal (pid ${pid}) is already using outputs/${m[1]} — wait for it` }); } catch { /* stale */ }
        }
        const mode = url.searchParams.get("mode");
        const run = startRun(m[1], { preview: mode === "preview", renderOnly: mode === "render", reuse: url.searchParams.get("reuse") === "1", gif: url.searchParams.get("gif") === "1" });
        return json(res, 200, { running: !run.done, estimate: run.estimate, startedAt: run.startedAt });
      }
      m = /^\/api\/run\/([a-z0-9-]+)\/stream$/.exec(p);
      if (m && req.method === "GET") {
        const run = runs.get(m[1]);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        if (!run) {
          res.write(`event: done\ndata: ${JSON.stringify({ code: null })}\n\n`);
          return res.end();
        }
        res.write(`event: stage\ndata: ${JSON.stringify({ stage: run.stage, at: run.stageAt, estimate: run.estimate, startedAt: run.startedAt })}\n\n`);
        for (const l of run.lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
        if (run.done) {
          res.write(`event: done\ndata: ${JSON.stringify({ code: run.code })}\n\n`);
          return res.end();
        }
        run.listeners.add(res);
        req.on("close", () => run.listeners.delete(res));
        return;
      }
      m = /^\/api\/take\/([a-z0-9-]+)$/.exec(p);
      if (m && req.method === "GET") {
        const dir = path.join(outRoot(), m[1]);
        const tp = path.join(dir, "take.json");
        if (!fs.existsSync(tp)) return json(res, 404, { error: "no take yet" });
        const take = JSON.parse(fs.readFileSync(tp, "utf8"));
        const files = fs.readdirSync(dir).filter((f) => !f.startsWith(".")).flatMap((f) =>
          f === "stills" ? fs.readdirSync(path.join(dir, "stills")).map((x) => `stills/${x}`) : [f]);
        const proof = fs.existsSync(path.join(dir, "proof-log.md")) ? fs.readFileSync(path.join(dir, "proof-log.md"), "utf8") : "";
        const facts = fs.existsSync(path.join(dir, "facts.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "facts.json"), "utf8")) : null;
        const stamp = fs.statSync(tp).mtimeMs;
        return json(res, 200, { take, files, proof, facts, stamp, dir });
      }
      m = /^\/out\/([a-z0-9-]+)\/((?:stills\/)?[A-Za-z0-9._-]+)$/.exec(p);
      if (m && req.method === "GET") {
        const f = path.join(outRoot(), m[1], m[2]);
        if (!fs.existsSync(f)) return json(res, 404, { error: "not found" });
        const stat = fs.statSync(f);
        const type = MIME[path.extname(f)] ?? "application/octet-stream";
        // Range support so <video> can seek.
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
        if (range && type === "video/mp4") {
          const start = Number(range[1] || 0);
          const end = range[2] ? Number(range[2]) : stat.size - 1;
          res.writeHead(206, { "content-type": type, "content-range": `bytes ${start}-${end}/${stat.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
          return fs.createReadStream(f, { start, end }).pipe(res);
        }
        res.writeHead(200, { "content-type": type, "content-length": stat.size, "cache-control": "no-store" });
        return fs.createReadStream(f).pipe(res);
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  server.listen(port, "127.0.0.1", () => process.stdout.write(`retake ui → http://localhost:${port}\n`));
  return server;
}
