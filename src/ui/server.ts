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
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { Manifest, loadManifest } from "../manifest.js";
import { PRESETS } from "../presets.js";
import { draftManifest, loadDotenv, pickProvider, providerStatus, scout, suggestIdeas } from "../describe.js";
import { gifskiBin, makeGif } from "../render.js";
import { captureHash } from "../record.js";
import { digest } from "../digest.js";

const ROOT = process.cwd();
const DEMOS = path.join(ROOT, "demos");
const OUT = path.join(ROOT, "outputs");
const DRAFTS = path.join(ROOT, ".drafts");

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

type Run = { proc: ChildProcess; lines: string[]; done: boolean; code: number | null; listeners: Set<http.ServerResponse>; stage: string; startedAt: number; stageAt: number; estimate: { capture: number; render: number } };
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
const MIME: Record<string, string> = { ".mp4": "video/mp4", ".gif": "image/gif", ".png": "image/png", ".md": "text/markdown", ".json": "application/json", ".html": "text/html", ".yaml": "text/yaml" };

function listDemos() {
  if (!fs.existsSync(DEMOS)) return [];
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
          scenes: m.steps.filter((st) => st.action === "scene").map((st) => ({ label: st.label, caption: st.caption ?? "", holdMs: st.holdMs ?? null, camera: st.camera === "static" ? "static" : typeof st.camera === "object" && st.camera.zoom ? st.camera.zoom : "auto" })),
        };
      } catch {
        valid = false;
      }
      const take = path.join(OUT, name, "take.json");
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
      return { name, file: f, title, url, valid, settings, lastTake, needsRecord };
    });
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
  const dir = path.join(OUT, name);
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
  const args = mode.renderOnly
    ? [path.join(ROOT, "src", "cli.ts"), "render", path.join(OUT, name), ...(mode.gif ? ["--gif"] : [])]
    : [path.join(ROOT, "src", "cli.ts"), "run", path.join(DEMOS, file)];
  if (!mode.renderOnly) {
    if (mode.preview) args.push("--preset", "preview-fast", "--reuse");
    else {
      if (mode.reuse) args.push("--reuse");
      if (mode.gif) args.push("--gif");
    }
  }
  const proc = spawn(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), ...args], {
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
  proc.stdout.on("data", push);
  proc.stderr.on("data", push);
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
function writeEnv(set: Record<string, string | undefined>) {
  const file = path.join(ROOT, ".env");
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) continue;
    const i = lines.findIndex((l) => l.startsWith(k + "="));
    const line = `${k}=${v}`;
    if (v === "") { if (i >= 0) lines.splice(i, 1); }
    else if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  fs.writeFileSync(file, lines.filter((l, i, a) => l !== "" || i < a.length - 1).join("\n").replace(/\n*$/, "\n"));
}
function envSummary() {
  return { localUrl: process.env.RETAKE_LOCAL_URL ?? "", localModel: process.env.RETAKE_LOCAL_MODEL ?? "", groq: !!process.env.GROQ_API_KEY, mistral: !!process.env.MISTRAL_API_KEY };
}

/** A navigation error, said the way a person would say it. */
function unreachable(url: string, e: Error): string {
  const m = e.message;
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(m)) return `Nothing is running at ${url}. Start your app first, then try again.`;
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(m)) return `Could not find ${new URL(url).host}. Check the address.`;
  if (/Timeout/.test(m)) return `${url} did not finish loading in time. Is it up?`;
  return m.split("\n")[0];
}

export function serve(port: number) {
  loadDotenv(ROOT);
  const page = fs.readFileSync(path.join(HERE, "index.html"), "utf8");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const p = url.pathname;
      if (p === "/" && req.method === "GET") {
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
        return res.end(fs.readFileSync(path.join(ROOT, "assets", `icon-${ic[1]}.png`)));
      }
      if (p === "/favicon.svg") {
        const f = path.join(ROOT, "assets", "logo.svg");
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=86400" });
        return res.end(fs.readFileSync(f));
      }
      if (p === "/api/demos" && req.method === "GET") return json(res, 200, listDemos());
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
      const mdel = /^\/api\/demos\/([a-z0-9-]+)$/.exec(p);
      if (mdel && req.method === "DELETE") {
        const file = path.join(DEMOS, `${mdel[1]}.yaml`);
        const out = path.join(OUT, mdel[1]);
        if (fs.existsSync(path.join(out, ".retake-lock"))) return json(res, 409, { error: "a run is using this demo right now — wait for it to finish" });
        // Never delete silently: the manifest goes to .trash/ with a timestamp so a slip is recoverable.
        const trash = path.join(ROOT, ".trash");
        fs.mkdirSync(trash, { recursive: true });
        if (fs.existsSync(file)) fs.renameSync(file, path.join(trash, `${mdel[1]}.${Date.now()}.yaml`));
        if (fs.existsSync(out)) fs.rmSync(out, { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
      const mg = /^\/api\/gif\/([a-z0-9-]+)$/.exec(p);
      if (mg && req.method === "POST") {
        const out = makeGif(path.join(OUT, mg[1]));
        return json(res, 200, { file: path.basename(out), size: fs.statSync(out).size });
      }
      if (p === "/api/ideas" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { url: string; project?: string };
        if (!/^https?:\/\//.test(b.url)) return json(res, 400, { error: "url must start with http(s)://" });
        const provider = pickProvider();
        if (!provider) return json(res, 400, { error: "no model configured — pick one in Settings" });
        let sc;
        try { sc = await scout(b.url); } catch (e) { return json(res, 400, { error: unreachable(b.url, e as Error) }); }
        const project = b.project ? b.project.replace(/^~/, os.homedir()).trim() : undefined;
        const { markdown, ideas } = await suggestIdeas({ url: b.url, scout: sc, provider, project });
        const file = path.join(ROOT, "ideas", `${new URL(b.url).host.replace(/[^a-z0-9]+/gi, "-")}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# Demo ideas — ${b.url}\n\n_Suggested by ${provider.name} (${provider.model})${project ? ` after reading ${project}` : ""}._\n\n${markdown}\n`);
        return json(res, 200, { ideas, file: path.relative(ROOT, file) });
      }
      if (p === "/api/project" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { dir: string };
        const dir = b.dir.replace(/^~/, os.homedir()).trim();
        try {
          const d = digest(dir);
          return json(res, 200, { ok: true, dir: d.dir, name: d.name, stack: d.stack, files: d.files, routes: d.routes.slice(0, 12), selectors: d.selectors.length, auth: d.auth.length > 0, flaky: d.flaky.length });
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
      }
      if (p === "/api/settings" && req.method === "GET") return json(res, 200, { ...providerStatus(), model: process.env.RETAKE_MODEL ?? "", gifski: !!gifskiBin(), env: envSummary() });
      if (p === "/api/settings" && req.method === "PUT") {
        const b = JSON.parse(await readBody(req)) as { model?: string; localUrl?: string; localModel?: string; groqKey?: string; mistralKey?: string };
        const set: Record<string, string | undefined> = { RETAKE_MODEL: b.model, RETAKE_LOCAL_URL: b.localUrl, RETAKE_LOCAL_MODEL: b.localModel, GROQ_API_KEY: b.groqKey, MISTRAL_API_KEY: b.mistralKey };
        writeEnv(set);
        for (const [k, v] of Object.entries(set)) if (v !== undefined) { if (v === "") delete process.env[k]; else process.env[k] = v; }
        return json(res, 200, { ...providerStatus(), model: process.env.RETAKE_MODEL ?? "", env: envSummary() });
      }
      const ms = /^\/api\/demos\/([a-z0-9-]+)\/settings$/.exec(p);
      if (ms && req.method === "PATCH") {
        const file = path.join(DEMOS, `${ms[1]}.yaml`);
        if (!fs.existsSync(file)) return json(res, 404, { error: "not found" });
        const b = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
        for (const k of ["preset", "layout", "camera", "cursor", "title"]) {
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
        try { sc = await scout(b.url); } catch (e) { return json(res, 400, { error: unreachable(b.url, e as Error) }); }
        const project = b.project ? b.project.replace(/^~/, os.homedir()).trim() : undefined;
        const d = await draftManifest({ name: b.name, url: b.url, describe: b.describe, scout: sc, provider, project });
        fs.mkdirSync(DEMOS, { recursive: true });
        fs.writeFileSync(file, d.yaml);
        return json(res, 200, { name: b.name, provider: d.provider, retried: d.retried, scouted: sc.elements.length, read: d.digest ? d.digest.files : 0 });
      }
      if (p === "/api/demos" && req.method === "POST") {
        const b = JSON.parse(await readBody(req)) as { name: string; url: string; describe: string };
        if (!b.name) b.name = nextProjectName();
        if (!safeName(b.name)) return json(res, 400, { error: "name must be kebab-case" });
        const file = path.join(DEMOS, `${b.name}.yaml`);
        if (fs.existsSync(file)) return json(res, 409, { error: "a demo with that name exists" });
        fs.mkdirSync(DEMOS, { recursive: true });
        fs.writeFileSync(file, starterManifest(b.name, b.url, b.describe ?? ""));
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
            else if (b.camera === "auto") node.delete("camera");
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
        const lock = path.join(OUT, m[1], ".retake-lock");
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
        const dir = path.join(OUT, m[1]);
        const tp = path.join(dir, "take.json");
        if (!fs.existsSync(tp)) return json(res, 404, { error: "no take yet" });
        const take = JSON.parse(fs.readFileSync(tp, "utf8"));
        const files = fs.readdirSync(dir).filter((f) => !f.startsWith("."));
        const proof = fs.existsSync(path.join(dir, "proof-log.md")) ? fs.readFileSync(path.join(dir, "proof-log.md"), "utf8") : "";
        const facts = fs.existsSync(path.join(dir, "facts.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "facts.json"), "utf8")) : null;
        const stamp = fs.statSync(tp).mtimeMs;
        return json(res, 200, { take, files, proof, facts, stamp });
      }
      m = /^\/out\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(p);
      if (m && req.method === "GET") {
        const f = path.join(OUT, m[1], m[2]);
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
