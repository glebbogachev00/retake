/**
 * The operator's hands: Retake exposed as MCP tools.
 *
 * The operator is the signed-in coding agent (Claude Code or Codex) driving
 * Retake — the way a person drives it from a terminal, except it can ONLY do
 * what these tools allow. No shell. Starting the app and asking the person a
 * question are tools too, and both block until the UI answers, so the human
 * stays in the loop exactly where it matters and nowhere else.
 *
 * Runs as a stdio MCP server, spawned by the CLI. It reports progress back to
 * the UI over HTTP (RETAKE_UI + RETAKE_SESSION) so the person sees what is
 * happening in plain sentences.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import YAML from "yaml";
import { loadManifest, resolve } from "../manifest.js";
import { record, captureHash, acquireLock, releaseLock, type Take } from "../record.js";
import { render, check } from "../render.js";
import { dryRun } from "../dryrun.js";
import { scout, draftManifest, pickProvider, loadDotenv, type Edit } from "../describe.js";
import { digest } from "../digest.js";
import { applyEdits, receiptsFor } from "../edits.js";

const ROOT = process.env.RETAKE_ROOT || process.cwd();
const DEMOS = path.join(ROOT, "demos");
const OUT = process.env.RETAKE_OUT ? path.resolve(process.env.RETAKE_OUT.replace(/^~/, os.homedir())) : path.join(ROOT, "outputs");
const UI = process.env.RETAKE_UI || "";           // e.g. http://localhost:4310
const SESSION = process.env.RETAKE_SESSION || ""; // operator session id

loadDotenv(ROOT);

// --- talking to the UI ------------------------------------------------------

async function tell(line: string) {
  if (!UI || !SESSION) { process.stderr.write(line + "\n"); return; }
  await fetch(`${UI}/api/operator/${SESSION}/log`, { method: "POST", body: JSON.stringify({ line }) }).catch(() => {});
}

/** Block until the person answers in the UI. `kind` = question | approve. */
async function waitForHuman(kind: "question" | "approve", text: string, detail?: string): Promise<string> {
  if (!UI || !SESSION) throw new Error(`cannot ${kind} — no UI attached`);
  const r = await fetch(`${UI}/api/operator/${SESSION}/pending`, { method: "POST", body: JSON.stringify({ kind, text, detail }) });
  const { id } = (await r.json()) as { id: string };
  for (;;) {
    await new Promise((ok) => setTimeout(ok, 1200));
    const s = await fetch(`${UI}/api/operator/${SESSION}/pending/${id}`).then((x) => x.json()).catch(() => null) as { answered?: boolean; answer?: string } | null;
    if (s?.answered) return s.answer ?? "";
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const safe = (s: string) => /^[a-z0-9-]+$/.test(s);
const manifestPath = (name: string) => path.join(DEMOS, `${name}.yaml`);

function summariseTake(take: Take): string {
  const dur = take.duration - take.trimBefore;
  const fails = take.timeline.filter((t) => !t.ok);
  const lines = [`${take.ok ? "All" : `${take.timeline.length - fails.length} of`} ${take.timeline.length} steps passed · ${dur.toFixed(1)}s${take.partial ? ` · PARTIAL: ${take.partial}` : ""}`];
  for (const f of fails) lines.push(`  ✗ step ${f.index}: ${f.summary} — ${f.error}`);
  if (take.stubbed?.length) lines.push(`  stubbed: ${take.stubbed.join(", ")}`);
  return lines.join("\n");
}

function listeningPorts(): number[] {
  try {
    const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", timeout: 3000 });
    const ports = new Set<number>();
    for (const line of out.split("\n")) { const m = /:(\d{4,5})\s+\(LISTEN\)/.exec(line); if (m) ports.add(Number(m[1])); }
    return [...ports].filter((p) => p >= 1024 && p < 65535).sort((a, b) => a - b);
  } catch { return []; }
}

async function waitForUrl(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (r.status < 500) return true; } catch { /* not yet */ }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return false;
}

// --- the server --------------------------------------------------------------

const server = new McpServer({ name: "retake", version: "0.1.0" });

server.registerTool("ports", { description: "Which local TCP ports have something listening. Use this before assuming an app is down — dev servers often come up on the next free port (3000 → 3001/3022).", inputSchema: {} }, async () => {
  const ps = listeningPorts();
  return text(ps.length ? `Listening: ${ps.map((p) => ":" + p).join(", ")}` : "Nothing is listening on any local port.");
});

server.registerTool("read_project", { description: "Read an app's source folder: stack, how it starts, routes, sign-in fields, stable selectors, env vars, things that make recordings flaky. Cheap and local. Do this first when a folder is given.", inputSchema: { dir: z.string().describe("path to the project folder") } }, async ({ dir }) => {
  const d = digest(dir.replace(/^~/, os.homedir()));
  await tell(`Read ${d.name}: ${d.files} files · ${d.routes.length} routes · ${d.selectors.length} stable selectors · ${d.flaky.length} things to watch`);
  return text(d.text);
});

server.registerTool("scout", { description: "Open a URL headlessly and list what is on it: headings, visible controls with unique selectors, page text. Use the selectors it returns verbatim.", inputSchema: { url: z.string().url() } }, async ({ url }) => {
  const sc = await scout(url);
  await tell(`Looked at ${url}: ${sc.elements.length} controls${sc.headings[0] ? ` · “${sc.headings[0]}”` : ""}`);
  return text([`title: ${sc.title}`, `headings: ${sc.headings.join(" | ")}`, "controls (tag · selector · text):", ...sc.elements.map((e) => `- ${e.tag} · ${e.selector} · ${e.text || e.placeholder || e.href || ""}`), "", `text: ${sc.text.slice(0, 1200)}`].join("\n"));
});

server.registerTool("wait_for_url", { description: "Wait until a URL answers (up to the timeout). Use after starting an app.", inputSchema: { url: z.string().url(), seconds: z.number().int().min(5).max(180).default(60) } }, async ({ url, seconds }) => {
  await tell(`Waiting for ${url}…`);
  const ok = await waitForUrl(url, seconds * 1000);
  await tell(ok ? `${url} is answering.` : `${url} did not answer within ${seconds}s.`);
  return text(ok ? `up: ${url}` : `still down after ${seconds}s: ${url}`);
});

server.registerTool("start_app", {
  description: "Start the person's app from its folder. ASKS THE PERSON FOR APPROVAL FIRST and waits for their click — never assume yes. Returns the detected port/URL when something starts listening, plus the first log lines. Prefer the project's own dev/start script.",
  inputSchema: { dir: z.string(), command: z.string().describe("e.g. npm run dev, or vercel dev --listen 3200"), expect_url: z.string().url().optional().describe("if you know the URL, wait for it") },
}, async ({ dir, command, expect_url }) => {
  const cwd = dir.replace(/^~/, os.homedir());
  const answer = await waitForHuman("approve", `Start the app?`, `${command}\nin ${cwd}`);
  if (!/^(yes|y|ok|allow|approve|start)/i.test(answer.trim())) { await tell("Not starting the app — you said no."); return text("DENIED by the person. Do not retry without a different reason. Ask them how they'd like to proceed."); }
  const before = new Set(listeningPorts());
  await tell(`Starting: ${command}`);
  const logFile = path.join(os.tmpdir(), `retake-app-${Date.now()}.log`);
  const out = fs.openSync(logFile, "a");
  const child = spawn("/bin/sh", ["-lc", command], { cwd, env: process.env, stdio: ["ignore", out, out], detached: true });
  child.unref();
  // Watch for a new port (or the expected URL) for up to 90s.
  let url = expect_url ?? "", port = 0;
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    await new Promise((ok) => setTimeout(ok, 1500));
    if (url && (await waitForUrl(url, 1000))) break;
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::(\d{2,5}))?/.exec(log);
    if (m && m[1]) { port = Number(m[1]); url = `http://localhost:${port}`; if (await waitForUrl(url, 1000)) break; }
    const fresh = listeningPorts().filter((p) => !before.has(p));
    if (fresh.length) { port = fresh[0]; url = `http://localhost:${port}`; if (await waitForUrl(url, 1000)) break; }
  }
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").split("\n").slice(-12).join("\n") : "";
  fs.writeFileSync(path.join(os.tmpdir(), `retake-app-pid-${child.pid}`), String(child.pid));
  if (url && (await waitForUrl(url, 1000))) { await tell(`App is up at ${url}`); return text(`started (pid ${child.pid}) · answering at ${url}\nlog tail:\n${log}`); }
  await tell("Started, but nothing answered yet — see the log.");
  return text(`started (pid ${child.pid}) but no port answered within 90s. log tail:\n${log}\nCheck the log for the real port or a missing env var, then wait_for_url or ask the person.`);
});

server.registerTool("ask", { description: "Ask the person ONE question and wait for the answer. Use only when genuinely blocked (which app, a credential name, a choice between two things). Keep it one sentence, with the evidence.", inputSchema: { question: z.string() } }, async ({ question }) => {
  const a = await waitForHuman("question", question);
  return text(`They answered: ${a}`);
});

server.registerTool("list_demos", { description: "Demos that exist, with their last take.", inputSchema: {} }, async () => {
  if (!fs.existsSync(DEMOS)) return text("no demos yet");
  const rows = fs.readdirSync(DEMOS).filter((f) => /\.ya?ml$/.test(f)).map((f) => {
    const name = f.replace(/\.ya?ml$/, "");
    const tp = path.join(OUT, name, "take.json");
    let last = "no take";
    if (fs.existsSync(tp)) { try { const t = JSON.parse(fs.readFileSync(tp, "utf8")) as Take; last = `${t.ok ? "ok" : "failed"} · ${(t.duration - t.trimBefore).toFixed(0)}s`; } catch { /* ignore */ } }
    return `- ${name} (${last})`;
  });
  return text(rows.join("\n") || "no demos yet");
});

server.registerTool("read_manifest", { description: "The YAML of a demo.", inputSchema: { name: z.string() } }, async ({ name }) => {
  if (!safe(name) || !fs.existsSync(manifestPath(name))) return text(`no demo "${name}"`);
  return text(fs.readFileSync(manifestPath(name), "utf8"));
});

server.registerTool("write_manifest", { description: "Create or replace a demo's YAML. It is validated; errors come back instead of being written. Prefer `edit` for small changes to an existing demo.", inputSchema: { name: z.string(), yaml: z.string() } }, async ({ name, yaml }) => {
  if (!safe(name)) return text("name must be kebab-case");
  let parsed;
  try { parsed = YAML.parse(yaml); } catch (e) { return text(`not valid YAML: ${(e as Error).message}`); }
  const { Manifest } = await import("../manifest.js");
  const r = Manifest.safeParse(parsed);
  if (!r.success) return text("invalid manifest:\n" + r.error.issues.map((i) => `- ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"));
  fs.mkdirSync(DEMOS, { recursive: true });
  fs.writeFileSync(manifestPath(name), yaml);
  await tell(`Wrote demos/${name}.yaml — ${r.data.steps.length} steps, ${r.data.steps.filter((s) => s.action === "scene").length} scenes`);
  return text(`written: demos/${name}.yaml (${r.data.steps.length} steps)`);
});

server.registerTool("draft", { description: "Let Retake draft a manifest from a sentence: scouts the URL (and reads the project if given) and writes demos/<name>.yaml. Then dry-run it.", inputSchema: { name: z.string(), url: z.string().url(), describe: z.string(), project: z.string().optional() } }, async ({ name, url, describe, project }) => {
  if (!safe(name)) return text("name must be kebab-case");
  const provider = pickProvider();
  if (!provider) return text("no drafting model configured; write the manifest yourself with write_manifest");
  const sc = await scout(url);
  const d = await draftManifest({ name, url, describe, scout: sc, provider, project: project?.replace(/^~/, os.homedir()) });
  fs.mkdirSync(DEMOS, { recursive: true });
  fs.writeFileSync(manifestPath(name), d.yaml);
  const m = loadManifest(manifestPath(name)).manifest;
  await tell(`Drafted demos/${name}.yaml — ${m.steps.length} steps, ${m.steps.filter((s) => s.action === "scene").length} scenes`);
  return text(`drafted demos/${name}.yaml (${m.steps.length} steps). Next: dry.\n\n${d.yaml}`);
});

server.registerTool("edit", { description: "Make small structured changes to a demo (captions, camera, holds, trim, waits, selectors, text, delete a step). Keeps comments. Returns what changed and whether it needs re-recording.", inputSchema: { name: z.string(), edits: z.array(z.object({ op: z.string() }).passthrough()) } }, async ({ name, edits }) => {
  if (!safe(name) || !fs.existsSync(manifestPath(name))) return text(`no demo "${name}"`);
  const a = applyEdits(manifestPath(name), edits as Edit[]);
  for (const d of a.done) await tell(d);
  return text([`applied: ${a.done.join("; ") || "nothing"}`, a.skipped.length ? `skipped: ${a.skipped.join("; ")}` : "", a.rerecord ? "needs re-record" : "render-only change"].filter(Boolean).join("\n"));
});

server.registerTool("dry", { description: "Run a demo with no camera: every selector and wait, strict. Seconds, not minutes. ALWAYS do this before run. Failures include what was on screen.", inputSchema: { name: z.string() } }, async ({ name }) => {
  if (!safe(name) || !fs.existsSync(manifestPath(name))) return text(`no demo "${name}"`);
  const { manifest } = loadManifest(manifestPath(name));
  await tell(`Checking every step of ${name} on the page…`);
  const r = await dryRun(manifest, DEMOS, () => {});
  await tell(r.ok ? `Checked: all ${manifest.steps.length} steps resolve` : `${r.failures} step(s) would fail`);
  return text(r.ok ? `ok: all ${manifest.steps.length} steps resolve` : r.lines.join("\n"));
});

server.registerTool("run", { description: "Record the demo and render it. Slow (the demo is performed in real time). preview=true for a fast low-cost render to check the story. Returns the receipts.", inputSchema: { name: z.string(), preview: z.boolean().default(true) } }, async ({ name, preview }) => {
  if (!safe(name) || !fs.existsSync(manifestPath(name))) return text(`no demo "${name}"`);
  const loaded = loadManifest(manifestPath(name));
  const manifest = preview ? { ...loaded.manifest, preset: "preview-fast" } : loaded.manifest;
  const outDir = path.join(OUT, name);
  acquireLock(outDir);
  try {
    for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) if (f !== ".retake-lock") fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
    await tell(`Recording ${name}${preview ? " (preview)" : ""}…`);
    const take = await record(manifest, { outDir, manifestDir: DEMOS, locked: true, log: () => {} });
    await tell(`Rendering…`);
    const a = await render(manifest, take, outDir, {});
    const c = check(outDir, manifest);
    await tell(`${take.ok ? "Take done — all steps ok" : "Take done — some steps failed"} · ${(take.duration - take.trimBefore).toFixed(0)}s`);
    return text(`${summariseTake(take)}\nvideo: ${a.mp4 ?? "none"}\ncheck: ${c.ok ? "pass" : "FAIL"}\n${c.lines.filter((l) => l.startsWith("FAIL")).join("\n")}`);
  } finally {
    releaseLock(outDir);
  }
});

server.registerTool("render", { description: "Re-render the last recording of a demo with the current manifest (captions, camera, trim, format). No browser, seconds.", inputSchema: { name: z.string() } }, async ({ name }) => {
  const outDir = path.join(OUT, name);
  const tp = path.join(outDir, "take.json");
  if (!fs.existsSync(tp)) return text("no recording yet — run first");
  const { manifest } = loadManifest(manifestPath(name));
  const take = JSON.parse(fs.readFileSync(tp, "utf8")) as Take;
  if (take.captureHash && take.captureHash !== captureHash(manifest)) return text("the recording no longer matches the manifest's steps — use run, not render");
  await tell(`Re-rendering ${name}…`);
  const a = await render(manifest, take, outDir, { force: true });
  return text(`rendered: ${a.mp4}`);
});

server.registerTool("receipts", { description: "What happened in the last take of a demo: per-step pass/fail with timings, scene times, stubs. Read this before deciding what to change.", inputSchema: { name: z.string() } }, async ({ name }) => {
  const tp = path.join(OUT, name, "take.json");
  if (!fs.existsSync(tp) || !fs.existsSync(manifestPath(name))) return text("no take yet");
  const take = JSON.parse(fs.readFileSync(tp, "utf8")) as Take;
  const { manifest } = loadManifest(manifestPath(name));
  return text(receiptsFor(take, manifest.steps as never));
});

server.registerTool("done", { description: "Call when the demo is recorded and acceptable (or when you are stopping). One sentence for the person.", inputSchema: { summary: z.string(), demo: z.string().optional() } }, async ({ summary, demo }) => {
  await tell(`Done: ${summary}`);
  if (UI && SESSION) await fetch(`${UI}/api/operator/${SESSION}/done`, { method: "POST", body: JSON.stringify({ summary, demo }) }).catch(() => {});
  return text("ok");
});

const transport = new StdioServerTransport();
await server.connect(transport);
