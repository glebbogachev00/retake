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
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import YAML from "yaml";
import { loadManifest, resolve } from "../manifest.js";
import { record, captureHash, acquireLock, releaseLock, type Take } from "../record.js";
import { render, check, ffmpegBin } from "../render.js";
import { execFileSync } from "node:child_process";
import { dryRun } from "../dryrun.js";
import { scout, draftManifest, suggestIdeas, pickProvider, loadDotenv, type Edit } from "../describe.js";
import { digest } from "../digest.js";
import { startApp as reallyStartApp, listeningPorts as ports, waitForUrl as waitUrl } from "../appserver.js";
import { applyEdits, receiptsFor } from "../edits.js";
import { SECRET_NAME, missingSecrets, readEnvFile } from "../env.js";

const ROOT = process.env.RETAKE_ROOT || process.cwd();
const DEMOS = path.join(ROOT, "demos");
const OUT = process.env.RETAKE_OUT ? path.resolve(process.env.RETAKE_OUT.replace(/^~/, os.homedir())) : path.join(ROOT, "outputs");
let LAST_DEMO = "";                                // what the agent is working on
const UI = process.env.RETAKE_UI || "";           // e.g. http://localhost:4310
const SESSION = process.env.RETAKE_SESSION || ""; // operator session id
const PROJECT = process.env.RETAKE_PROJECT || "";

loadDotenv(ROOT);
// A selected project already owns the environment used by its dev server. Make
// those same values available to ${ENV_VAR} references during dry/run without
// copying secrets into manifests or exposing them to the coding-agent process.
if (PROJECT) loadDotenv(PROJECT, [".env.local", ".env"]);

// --- talking to the UI ------------------------------------------------------

async function tell(line: string) {
  if (!UI) { process.stderr.write(line + "\n"); return; }
  // Driven from somebody else's agent there is no session, but the app is
  // still open on the desk — report to the activity feed so it can be watched.
  if (!SESSION) { await fetch(`${UI}/api/activity`, { method: "POST", body: JSON.stringify({ line, who: process.env.RETAKE_WHO || "your agent", demo: LAST_DEMO || undefined }) }).catch(() => {}); return; }
  await fetch(`${UI}/api/operator/${SESSION}/log`, { method: "POST", body: JSON.stringify({ line }) }).catch(() => {});
}

/** Block until the person answers in the UI. `kind` = question | approve.
    With no UI attached (Retake driven by someone's own agent) there is nobody
    here to click, so the caller must have asked its own user instead. */
export class NoUI extends Error {}
async function waitForHuman(kind: "question" | "approve", text: string, detail?: string): Promise<string> {
  if (!UI || !SESSION) throw new NoUI(kind);
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

// --- the server --------------------------------------------------------------

const server = new McpServer({ name: "retake", version: "0.1.0" });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const READ_LIVE_APP = { ...READ_ONLY, openWorldHint: true } as const;
const RETAKE_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

server.registerTool("ports", { description: "Which local TCP ports have something listening. Use this before assuming an app is down — dev servers often come up one port over (3000 → 3001/3022).", inputSchema: {}, annotations: READ_ONLY }, async () => {
  const ps = ports();
  return text(ps.length ? `Listening: ${ps.map((p) => ":" + p).join(", ")}` : "Nothing is listening on any local port.");
});

server.registerTool("read_project", { description: "Read an app's source folder: stack, how it starts, routes, sign-in fields, stable selectors, env vars, things that make recordings flaky. Cheap and local. Do this first when a folder is given.", inputSchema: { dir: z.string().describe("path to the project folder") }, annotations: READ_ONLY }, async ({ dir }) => {
  const d = digest(dir.replace(/^~/, os.homedir()));
  await tell(`Read ${d.name}: ${d.files} files · ${d.routes.length} routes · ${d.selectors.length} stable selectors · ${d.flaky.length} things to watch`);
  return text(d.text);
});

server.registerTool("scout", { description: "Open a URL headlessly and list what is on it: headings, visible controls with unique selectors, page text. Use the selectors it returns verbatim.", inputSchema: { url: z.string().url() }, annotations: READ_LIVE_APP }, async ({ url }) => {
  const sc = await scout(url);
  await tell(`Looked at ${url}: ${sc.elements.length} controls${sc.headings[0] ? ` · “${sc.headings[0]}”` : ""}`);
  return text([`title: ${sc.title}`, `headings: ${sc.headings.join(" | ")}`, "controls (tag · selector · text):", ...sc.elements.map((e) => `- ${e.tag} · ${e.selector} · ${e.text || e.placeholder || e.href || ""}`), "", `text: ${sc.text.slice(0, 1200)}`].join("\n"));
});

server.registerTool("wait_for_url", { description: "Wait until a URL answers (up to the timeout). Use after starting an app.", inputSchema: { url: z.string().url(), seconds: z.number().int().min(5).max(180).default(60) }, annotations: READ_LIVE_APP }, async ({ url, seconds }) => {
  await tell(`Waiting for ${url}…`);
  const ok = await waitUrl(url, seconds * 1000);
  await tell(ok ? `${url} is answering.` : `${url} did not answer within ${seconds}s.`);
  return text(ok ? `up: ${url}` : `still down after ${seconds}s: ${url}`);
});

server.registerTool("start_app", {
  description: "Start the person's app from its folder and report the URL it actually came up on. Requests initiated inside Retake are already authorized by the project workflow. When driven from an external agent, RETAKE_ALLOW_START=1 remains required.",
  inputSchema: { dir: z.string(), command: z.string().describe("e.g. npm run dev, or vercel dev --listen 3200"), expect_url: z.string().url().optional().describe("if you know the URL, wait for it") },
  annotations: RETAKE_WRITE,
}, async ({ dir, command, expect_url }) => {
  const cwd = dir.replace(/^~/, os.homedir());
  // A Retake UI session exists only after the person has selected this project
  // and asked for a scan/recording. Outside the UI, preserve the explicit gate.
  if ((!UI || !SESSION) && process.env.RETAKE_ALLOW_START !== "1") {
    return text(`NOT RUN. Retake will not start processes when it is driven from outside its own window, unless the person allowed it when they set Retake up. Tell them: to let this work, add RETAKE_ALLOW_START=1 to Retake's MCP config env and restart.`);
  }
  await tell(`Starting: ${command}`);
  const r = await reallyStartApp({ dir: cwd, command, expectUrl: expect_url, onProgress: (l) => void tell(l) });
  if (r.ok) { await tell(`App is up at ${r.url}`); return text(`started (pid ${r.pid}) · answering at ${r.url}`); }
  await tell(`Could not start it: ${r.why}`);
  return text(`FAILED: ${r.why}\nlog tail:\n${r.log.slice(-800)}`);
});

server.registerTool("secrets", {
  description: [
    "Get the person's demo-account credentials into place WITHOUT ever seeing them. Call this the moment a demo needs a login (read_project found sign-in fields, scout found a password field, or they said so): pass the variable NAMES you will use (APP_USER, APP_PASSWORD, and APP_TOTP_SECRET if the site asks for an authenticator code).",
    "What happens: if the Retake window is open, a form appears there and the person types the values, which go straight into the workspace .env — you get back 'set'. If no window is open, you get back the one-line instruction to relay. Either way, the manifest then references them as ${APP_USER} / ${APP_PASSWORD} with `secret: true`, inside auth.setup, and the values never appear in any log, the video, or this conversation.",
    "Never ask for a password in chat, never put a literal credential in a manifest, never invent values. For logins a script cannot do (SMS code, SSO, captcha) the answer is `retake signin demos/<name>.yaml` — the person signs in once in a real window and Retake keeps the session.",
  ].join(" "),
  inputSchema: {
    names: z.array(z.string().regex(SECRET_NAME, "UPPER_SNAKE names like APP_PASSWORD")).min(1).describe("the environment variable names the manifest will reference"),
    why: z.string().describe("one sentence the person will read: what the login is for, e.g. 'The dashboard demo starts behind the admin sign-in.'"),
  },
  annotations: RETAKE_WRITE,
}, async ({ names, why }) => {
  const reload = () => { for (const [k, v] of Object.entries(readEnvFile(ROOT))) if (v.trim()) process.env[k] = v; };
  reload();
  const how = (missing: string[]) => `Reference them as ${names.map((n) => "${" + n + "}").join(", ")} with \`secret: true\` inside auth.setup (a TOTP secret as ${"${TOTP:" + (names.find((n) => /TOTP/.test(n)) ?? "APP_TOTP_SECRET") + "}"} — Retake computes the current code).` + (missing.length ? "" : " The values stay in .env; you never see them, and they are never on camera.");
  let missing = missingSecrets(ROOT, names);
  if (!missing.length) return text(`All set already: ${names.join(", ")} are in the workspace .env. ${how([])}`);
  const relay = `Tell the person, in these words: “Retake needs a demo account for this. Run \`retake secret ${missing.join(" ")}\` in your Retake workspace and type the values there (they stay on your machine) — or open \`retake ui\` and I'll ask you there. If the sign-in needs a code from your phone, SSO or a captcha, run \`retake signin demos/<name>.yaml\` instead and log in once by hand.” Then call this tool again.`;
  if (!UI) return text(`Missing: ${missing.join(", ")}. No Retake window is open. ${relay}`);
  let id: string;
  try {
    const r = await fetch(`${UI}/api/secrets/request`, { method: "POST", body: JSON.stringify({ names: missing, why }) });
    if (!r.ok) throw new Error(String(r.status));
    id = ((await r.json()) as { id: string }).id;
  } catch {
    return text(`Missing: ${missing.join(", ")}. The Retake window at ${UI} is not answering. ${relay}`);
  }
  await tell(`Waiting for you: ${missing.join(", ")} — a form is open in the window.`);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((ok) => setTimeout(ok, 1500));
    const st = await fetch(`${UI}/api/secrets/${id}`).then((x) => x.json()).catch(() => null) as { filled?: boolean; missing?: string[] } | null;
    if (st?.filled) { reload(); return text(`Set: ${names.join(", ")} — typed into the Retake window and saved to the workspace .env. ${how([])} Continue.`); }
  }
  reload(); missing = missingSecrets(ROOT, names);
  if (!missing.length) return text(`Set: ${names.join(", ")}. ${how([])} Continue.`);
  return text(`Still missing after ten minutes: ${missing.join(", ")}. The form is open in the Retake window; ${relay}`);
});

server.registerTool("ask", { description: "Ask the person ONE question and wait for the answer. Use only when genuinely blocked (which app, a choice between two things). Keep it one sentence, with the evidence. NEVER for passwords or tokens — that is what `secrets` is for.", inputSchema: { question: z.string() }, annotations: RETAKE_WRITE }, async ({ question }) => {
  try {
    const a = await waitForHuman("question", question);
    return text(`They answered: ${a}`);
  } catch (e) {
    if (!(e instanceof NoUI)) throw e;
    return text(`No Retake window is open, so ask the person yourself: “${question}” Then carry on with their answer.`);
  }
});

server.registerTool("style", {
  description: "Read or set the person's standing style for this project's demos (demos/style.md) — camera, cursor, captions, pacing, format. Set it the first time they express taste ('no zooms', 'hide the cursor') so they never repeat it; every draft reads it. Call with no text to read.",
  inputSchema: { text: z.string().optional().describe("the style note to save; omit to read") },
  annotations: RETAKE_WRITE,
}, async ({ text: t }) => {
  const file = path.join(DEMOS, "style.md");
  if (t === undefined) { try { return text(fs.readFileSync(file, "utf8")); } catch { return text("no style note yet — defaults apply: still camera, cursor shown, plain captions"); } }
  fs.mkdirSync(DEMOS, { recursive: true });
  fs.writeFileSync(file, t.trim() + "\n");
  await tell("Style saved — every draft here will follow it.");
  return text("saved to demos/style.md");
});

server.registerTool("ideas", {
  description: "What is worth recording. Reads the live page (and the source folder if given) and returns a short list of demo ideas, each a title and a one-sentence story. Use this when the person asks what demos to make — do not invent ideas yourself. Saves the list to demos/ideas.md.",
  inputSchema: { url: z.string().url(), project: z.string().optional() },
  annotations: READ_ONLY,
}, async ({ url, project }) => { LAST_DEMO = "";
  await tell("Looking for demos worth making…");
  const provider = pickProvider();
  if (!provider) return text("NO PROVIDER — Retake has no model configured. You know the app better than a blind draft would: propose ideas yourself from read_project.");
  const sc = await scout(url);
  const r = await suggestIdeas({ url, scout: sc, provider, project: project?.replace(/^~/, os.homedir()) });
  fs.mkdirSync(DEMOS, { recursive: true });
  fs.writeFileSync(path.join(DEMOS, "ideas.md"), r.markdown);
  await tell(`${r.ideas.length} ideas → demos/ideas.md`);
  return text(r.ideas.map((i, n) => `${n + 1}. ${i.title} — ${i.story} (${i.length})`).join("\n") || r.markdown);
});

// The plan is what makes "record them all" one job instead of five the model
// has to remember. It lives on disk, so a new session can pick up where the
// last one stopped.
const PLAN = () => path.join(DEMOS, "plan.json");
type PlanItem = { name: string; story: string; status: "todo" | "recorded" | "final" | "failed"; note?: string };
function readPlan(): PlanItem[] { try { return JSON.parse(fs.readFileSync(PLAN(), "utf8")) as PlanItem[]; } catch { return []; } }
function planText(items: PlanItem[]): string {
  if (!items.length) return "no plan — make one with plan_set";
  const left = items.filter((i) => i.status === "todo" || i.status === "failed").length;
  return items.map((i) => `[${i.status}] ${i.name} — ${i.story}${i.note ? ` (${i.note})` : ""}`).join("\n") + (left ? `\n\n${left} still to do.` : "\n\nAll done.");
}

server.registerTool("plan_set", {
  description: "Write the list of demos to record (kebab-case names + one-sentence stories). Replaces the plan. Then work through it: draft → dry → run for each, marking progress with plan_mark.",
  inputSchema: { items: z.array(z.object({ name: z.string(), story: z.string() })) },
  annotations: RETAKE_WRITE,
}, async ({ items }) => {
  const old = readPlan();
  const merged: PlanItem[] = items.map((i) => ({ name: i.name, story: i.story, status: old.find((o) => o.name === i.name)?.status ?? "todo" }));
  fs.mkdirSync(DEMOS, { recursive: true });
  fs.writeFileSync(PLAN(), JSON.stringify(merged, null, 2));
  await tell(`Plan: ${merged.length} demos.`);
  return text(planText(merged));
});

server.registerTool("plan", {
  description: "The current plan and what is left. Check this at the start of a batch session — an unfinished plan from before continues here.",
  inputSchema: {},
  annotations: READ_ONLY,
}, async () => text(planText(readPlan())));

server.registerTool("plan_mark", {
  description: "Record progress on one plan item: recorded (preview done), final (full-quality render done), failed (with a note saying why), or todo to reset it.",
  inputSchema: { name: z.string(), status: z.enum(["todo", "recorded", "final", "failed"]), note: z.string().optional() },
  annotations: RETAKE_WRITE,
}, async ({ name, status, note }) => {
  const items = readPlan();
  const it = items.find((i) => i.name === name);
  if (!it) return text(`"${name}" is not in the plan. Items: ${items.map((i) => i.name).join(", ") || "none"}`);
  it.status = status; it.note = note;
  fs.writeFileSync(PLAN(), JSON.stringify(items, null, 2));
  const left = items.filter((i) => i.status === "todo" || i.status === "failed").length;
  await tell(`${name}: ${status}${note ? ` — ${note}` : ""} · ${left} to go`);
  return text(planText(items));
});

server.registerTool("list_demos", { description: "Demos that exist, with their last take.", inputSchema: {}, annotations: READ_ONLY }, async () => {
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

server.registerTool("read_manifest", { description: "The YAML of a demo.", inputSchema: { name: z.string() }, annotations: READ_ONLY }, async ({ name }) => { LAST_DEMO = name;
  if (!safe(name) || !fs.existsSync(manifestPath(name))) return text(`no demo "${name}"`);
  return text(fs.readFileSync(manifestPath(name), "utf8"));
});

server.registerTool("write_manifest", { description: "Create or replace a demo's YAML. It is validated; errors come back instead of being written. Prefer `edit` for small changes to an existing demo.", inputSchema: { name: z.string(), yaml: z.string() }, annotations: RETAKE_WRITE }, async ({ name, yaml }) => { LAST_DEMO = name;
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

server.registerTool("draft", { description: "Let Retake draft a manifest from a sentence: scouts the URL (and reads the project if given) and writes demos/<name>.yaml. Then dry-run it.", inputSchema: { name: z.string(), url: z.string().url(), describe: z.string(), project: z.string().optional() }, annotations: RETAKE_WRITE }, async ({ name, url, describe, project }) => { LAST_DEMO = name;
  if (!safe(name)) return text("name must be kebab-case");
  const provider = pickProvider();
  if (!provider) return text("no drafting model configured; write the manifest yourself with write_manifest");
  const sc = await scout(url);
  const d = await draftManifest({ name, url, describe, scout: sc, provider, project: project?.replace(/^~/, os.homedir()), demosDir: DEMOS });
  fs.mkdirSync(DEMOS, { recursive: true });
  fs.writeFileSync(manifestPath(name), d.yaml);
  const m = loadManifest(manifestPath(name)).manifest;
  await tell(`Drafted demos/${name}.yaml — ${m.steps.length} steps, ${m.steps.filter((s) => s.action === "scene").length} scenes`);
  return text(`drafted demos/${name}.yaml (${m.steps.length} steps). Next: dry.\n\n${d.yaml}`);
});

server.registerTool("edit", { description: "Make small structured changes to a demo without rewriting it: captions, camera, holds, trim, waits, selectors, text; delete_step; insert_step {after, step:{action,…}} to add one step; set_step {step, value:{action,…}} to replace one. Steps are validated. Keeps comments. Returns what changed and whether it needs re-recording. Prefer this over write_manifest — one verb costs a line, a rewrite costs the file.", inputSchema: { name: z.string(), edits: z.array(z.object({ op: z.string() }).passthrough()) }, annotations: RETAKE_WRITE }, async ({ name, edits }) => { LAST_DEMO = name;
  if (!safe(name) || !fs.existsSync(manifestPath(name))) return text(`no demo "${name}"`);
  const a = applyEdits(manifestPath(name), edits as Edit[]);
  for (const d of a.done) await tell(d);
  return text([`applied: ${a.done.join("; ") || "nothing"}`, a.skipped.length ? `skipped: ${a.skipped.join("; ")}` : "", a.rerecord ? "needs re-record" : "render-only change"].filter(Boolean).join("\n"));
});

server.registerTool("dry", { description: "Run a demo with no camera: every selector and wait, strict. Seconds, not minutes. ALWAYS do this before run. Failures include what was on screen.", inputSchema: { name: z.string() }, annotations: RETAKE_WRITE }, async ({ name }) => { LAST_DEMO = name;
  if (!safe(name) || !fs.existsSync(manifestPath(name))) return text(`no demo "${name}"`);
  const { manifest } = loadManifest(manifestPath(name));
  await tell(`Checking every step of ${name} on the page…`);
  const r = await dryRun(manifest, DEMOS, () => {});
  await tell(r.ok ? `Checked: all ${manifest.steps.length} steps resolve` : `${r.failures} step(s) would fail`);
  return text(r.ok ? `ok: all ${manifest.steps.length} steps resolve` : r.lines.join("\n"));
});

server.registerTool("run", { description: "Record the demo and render it. Slow (the demo is performed in real time). preview=true for a fast low-cost render to check the story. Returns the receipts.", inputSchema: { name: z.string(), preview: z.boolean().default(true), until: z.string().optional().describe("record up to the end of this scene label, then stop — for iterating on one beat of a long demo") }, annotations: RETAKE_WRITE }, async ({ name, preview, until }) => { LAST_DEMO = name;
  if (!safe(name) || !fs.existsSync(manifestPath(name))) return text(`no demo "${name}"`);
  const loaded = loadManifest(manifestPath(name));
  const manifest = preview ? { ...loaded.manifest, preset: "preview-fast" } : loaded.manifest;
  const outDir = path.join(OUT, name);
  acquireLock(outDir);
  try {
    for (const f of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) if (f !== ".retake-lock") fs.rmSync(path.join(outDir, f), { recursive: true, force: true });
    await tell(`Recording ${name}${preview ? " (preview)" : ""}…`);
    const take = await record(manifest, { outDir, manifestDir: DEMOS, locked: true, until, log: () => {} });
    await tell(`Rendering…`);
    const a = await render(manifest, take, outDir, {});
    const c = check(outDir, manifest);
    const failed = take.timeline.find((e) => e.ok === false);
    await tell(failed ? `Stopped at step ${failed.index}: ${failed.summary}` : `Take done — all steps ok · ${(take.duration - take.trimBefore).toFixed(0)}s`);
    // A failed take is a finding, not a result: say exactly where and what
    // the page showed, so even a small model gets a one-line repair.
    if (failed) return text(`FAILED at step ${failed.index} — ${failed.summary}: ${failed.error ?? "error"}${failed.screen ? `\nOn screen at that moment: “${failed.screen}”` : ""}\nThe camera stopped there (${(take.duration - take.trimBefore).toFixed(0)}s recorded). This is not a demo yet: edit the manifest, dry, run again. Do NOT call done on a failed take.\n\n${summariseTake(take)}`);
    return text(`${summariseTake(take)}\nvideo: ${a.mp4 ?? "none"}\ncheck: ${c.ok ? "pass" : "FAIL"}\n${c.lines.filter((l) => l.startsWith("FAIL")).join("\n")}`);
  } finally {
    releaseLock(outDir);
  }
});

server.registerTool("render", { description: "Re-render the last recording of a demo with the current manifest (captions, camera, trim, format). No browser, seconds.", inputSchema: { name: z.string() }, annotations: RETAKE_WRITE }, async ({ name }) => { LAST_DEMO = name;
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

server.registerTool("receipts", { description: "What happened in the last take of a demo: per-step pass/fail with timings, scene times, stubs. Read this before deciding what to change.", inputSchema: { name: z.string() }, annotations: READ_ONLY }, async ({ name }) => { LAST_DEMO = name;
  const tp = path.join(OUT, name, "take.json");
  if (!fs.existsSync(tp) || !fs.existsSync(manifestPath(name))) return text("no take yet");
  const take = JSON.parse(fs.readFileSync(tp, "utf8")) as Take;
  const { manifest } = loadManifest(manifestPath(name));
  return text(receiptsFor(take, manifest.steps as never));
});

// "All steps passed" is not "looks right". The stills are how a reader with
// eyes judges a take — a badge in the corner, a board full of leftovers, a
// caption over the button. The agent gets the same eyes here: scene stills
// as images, or any frame by timestamp, scaled down so a look costs little.
server.registerTool("look", {
  description: "SEE the last take of a demo: returns one image per scene (the frame mid-scene), or the frame at a given second. Use after run/render, before deciding what to change — receipts tell you what happened, look tells you how it looks. Downscaled to keep it cheap; ask for a single scene or a specific second to go closer.",
  inputSchema: { name: z.string(), scene: z.string().optional().describe("one scene label only"), at: z.number().optional().describe("a second into the video instead of scenes"), frame: z.enum(["mid", "end"]).default("end").describe("end = the scene's last moment (did it happen?), mid = halfway (what was it doing?)"), width: z.number().int().min(320).max(1280).default(800) },
  annotations: READ_ONLY,
}, async ({ name, scene, at, frame: which, width }) => { LAST_DEMO = name;
  const dir = path.join(OUT, name);
  const mp4 = path.join(dir, "demo.mp4");
  if (!fs.existsSync(mp4)) return text("no rendered take yet — run first");
  const frame = (seconds: number, label: string) => {
    const out = path.join(os.tmpdir(), `retake-look-${process.pid}-${label.replace(/[^a-z0-9-]+/gi, "-")}.jpg`);
    execFileSync(ffmpegBin(), ["-y", "-loglevel", "error", "-ss", seconds.toFixed(2), "-i", mp4, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "5", out]);
    const b64 = fs.readFileSync(out).toString("base64");
    fs.rmSync(out, { force: true });
    return { type: "image" as const, data: b64, mimeType: "image/jpeg" };
  };
  if (at !== undefined) return { content: [{ type: "text" as const, text: `${name} at ${at.toFixed(1)}s` }, frame(at, `at-${at}`)] };
  const tp = path.join(dir, "take.json");
  const take = fs.existsSync(tp) ? (JSON.parse(fs.readFileSync(tp, "utf8")) as Take) : null;
  const scenes = (take?.timeline ?? []).filter((e) => e.action === "scene");
  if (!take || !scenes.length) return { content: [{ type: "text" as const, text: `${name}: no scenes — showing the middle` }, frame(1, "mid")] };
  const end = take.duration - take.trimBefore;
  const picked = scene ? scenes.filter((e) => e.label === scene) : scenes;
  if (!picked.length) return text(`no scene "${scene}" — scenes: ${scenes.map((e) => e.label).join(", ")}`);
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [];
  for (const [i, sc] of picked.entries()) {
    const idx = scenes.indexOf(sc);
    const from = sc.start - take.trimBefore;
    const next = scenes[idx + 1] ? scenes[idx + 1].start - take.trimBefore : end;
    const t = which === "end"
      ? Math.min(Math.max(from + 0.4, next - 0.6), Math.max(0, end - 0.2))
      : Math.min(Math.max(0, from + Math.max(0.8, (next - from) / 2)), Math.max(0, end - 0.2));
    content.push({ type: "text", text: `scene ${idx + 1}/${scenes.length} “${sc.label}” · ${from.toFixed(1)}–${next.toFixed(1)}s${sc.caption ? ` · caption: ${sc.caption}` : ""}` });
    content.push(frame(t, `${i}-${sc.label}`));
  }
  return { content };
});

server.registerTool("done", { description: "Call when the demo is recorded and acceptable (or when you are stopping). One sentence for the person.", inputSchema: { summary: z.string(), demo: z.string().optional() }, annotations: RETAKE_WRITE }, async ({ summary, demo }) => {
  await tell(`Done: ${summary}`);
  if (UI && !SESSION) await fetch(`${UI}/api/activity`, { method: "POST", body: JSON.stringify({ line: summary, demo, done: true }) }).catch(() => {});
  if (UI && SESSION) await fetch(`${UI}/api/operator/${SESSION}/done`, { method: "POST", body: JSON.stringify({ summary, demo }) }).catch(() => {});
  return text("ok");
});

const transport = new StdioServerTransport();
await server.connect(transport);
