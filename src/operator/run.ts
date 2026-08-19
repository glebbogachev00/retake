/**
 * Operator sessions: the signed-in coding agent driving Retake, fenced to
 * Retake's MCP tools, narrating to the UI, asking only when stuck.
 *
 * One session = one "make me a demo" request. The agent's shell is denied;
 * its only hands are src/operator/tools.ts. Approvals (start the app) and
 * questions come back here as pending items the UI shows, and the tool call
 * blocks until the person answers.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export type Pending = { id: string; kind: "question" | "approve"; text: string; detail?: string; answered: boolean; answer?: string; at: number };
export type Session = {
  id: string;
  proc: ChildProcess | null;
  lines: string[];
  pending: Pending[];
  done: boolean;
  code: number | null;
  summary?: string;
  demo?: string;
  cost?: number;
  turns?: number;
  startedAt: number;
  listeners: Set<(ev: { type: string; data: unknown }) => void>;
};

const sessions = new Map<string, Session>();
export const getSession = (id: string) => sessions.get(id);

function push(s: Session, type: string, data: unknown) {
  // Keep everything a person might want to re-read; the UI decides what to show.
  if (type === "line") s.lines.push(String(data));
  else if (type === "tool") s.lines.push(`→ ${String(data)}`);
  else if (type === "thought") s.lines.push(`  ${String(data)}`);
  for (const l of s.listeners) l({ type, data });
}

/** What the operator is told it is, and how to behave. Short on purpose: the
    tools carry their own instructions, and rules beat prose. */
export function brief(input: { describe: string; url?: string; project?: string; name?: string }): string {
  return [
    "You are Retake's operator. A person wants a demo video of their web app. You have Retake's tools and nothing else — no shell.",
    "",
    `What they want: ${input.describe}`,
    input.url ? `Their app is at: ${input.url}` : "They did not give a URL.",
    input.project ? `Their app's source is in: ${input.project}` : "No source folder was given.",
    input.name ? `Use the demo name: ${input.name}` : "Pick a short kebab-case demo name from what they asked for.",
    "",
    "How to work — the order that wins:",
    "1. If you have a folder, read_project first. It tells you routes, the start command, sign-in fields, selectors, and what animates forever.",
    "2. Make sure the app answers: scout the URL. If it refuses, check ports — dev servers often come up one port over. If it is really down and you have the folder and its start command, start_app (it asks the person for approval; that is fine). If you cannot tell which app or port is meant, ask — one question, with what you found.",
    "3. draft the manifest from the sentence (or write_manifest yourself if you know better). Read it. Fix obvious things with edit: wait for results not timers, unique selectors, logins under auth.setup with ${ENV} placeholders and secret: true, reducedMotion if things animate forever, scroll to long forms.",
    "4. dry. Always before run. Fix what it reports and dry again. Do not run a manifest whose dry run fails.",
    "5. run with preview=true. Read the receipts. If a step failed or the story is wrong, edit and run again. Two or three rounds is normal; more than four means ask the person.",
    "6. When it is good, run with preview=false once for the real quality, then done with one sentence.",
    "",
    "Rules:",
    "- Never type real passwords into a manifest; use ${ENV_VAR} and secret: true, and tell the person which variable to set.",
    "- Never invent selectors; use what scout/read_project returned.",
    "- Narrate nothing yourself — the tools already tell the person what is happening. Your text is for thinking; keep it short.",
    "- If the backend is unavailable, prefer a stub: block in the manifest over giving up; say so in done.",
    "- If the person denies an approval, do not retry it. Ask how they would like to proceed, or stop with done.",
  ].join("\n");
}

export function startOperator(input: { describe: string; url?: string; project?: string; name?: string; ui: string; root: string; provider: "claude-code" | "codex" }): Session {
  const id = "op" + Date.now().toString(36);
  const s: Session = { id, proc: null, lines: [], pending: [], done: false, code: null, startedAt: Date.now(), listeners: new Set() };
  sessions.set(id, s);

  const toolsEntry = path.join(HERE, "tools.ts");
  const tsx = path.join(input.root, "node_modules", "tsx", "dist", "cli.mjs");
  const mcpConfig = { mcpServers: { retake: { command: process.execPath, args: [tsx, toolsEntry], env: { RETAKE_ROOT: input.root, RETAKE_UI: input.ui, RETAKE_SESSION: id, RETAKE_OUT: process.env.RETAKE_OUT ?? "" } } } };
  const cfgPath = path.join(input.root, ".drafts", `mcp-${id}.json`);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(mcpConfig));

  // A clean env: inside another Claude Code session the inherited vars point
  // the child at the wrong auth (see describe.ts); HOME + PATH is enough.
  const env: Record<string, string> = { HOME: process.env.HOME ?? "", PATH: process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" };

  let proc: ChildProcess;
  if (input.provider === "claude-code") {
    proc = spawn("claude", [
      "-p", "--output-format", "stream-json", "--verbose",
      "--mcp-config", cfgPath, "--strict-mcp-config",
      // The fence: Retake's tools are allowed, the shell and editors are not.
      "--allowedTools", "mcp__retake__*",
      "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task",
      "--max-turns", "60",
    ], { env, cwd: input.root, stdio: ["pipe", "pipe", "pipe"] });
  } else {
    // Codex: MCP servers come from config; pass ours inline via -c and use read-only sandbox (our tools do the writing).
    proc = spawn("codex", [
      "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "--color", "never", "--json",
      "-c", `mcp_servers.retake.command="${process.execPath}"`,
      "-c", `mcp_servers.retake.args=["${tsx}","${toolsEntry}"]`,
      "-c", `mcp_servers.retake.env={RETAKE_ROOT="${input.root}",RETAKE_UI="${input.ui}",RETAKE_SESSION="${id}"}`,
      "-",
    ], { env, cwd: input.root, stdio: ["pipe", "pipe", "pipe"] });
  }
  s.proc = proc;
  proc.stdin?.write(brief(input));
  proc.stdin?.end();

  let buf = "";
  proc.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      try { handle(s, JSON.parse(line)); } catch { /* ignore */ }
    }
  });
  proc.stderr?.on("data", (c: Buffer) => { const t = c.toString().trim(); if (t && !/SessionEnd hook|hook_/.test(t)) push(s, "line", `· ${t.slice(0, 200)}`); });
  proc.on("close", (code) => { s.done = true; s.code = code; push(s, "done", { code, summary: s.summary, demo: s.demo, cost: s.cost, turns: s.turns }); fs.rmSync(cfgPath, { force: true }); });
  return s;
}

/** Turn the CLI's event stream into plain lines for the page. */
function handle(s: Session, d: Record<string, unknown>) {
  const type = d.type as string;
  if (type === "assistant") {
    const content = ((d.message as { content?: { type: string; text?: string; name?: string; input?: Record<string, unknown> }[] })?.content) ?? [];
    for (const c of content) {
      if (c.type === "tool_use") {
        const name = String(c.name ?? "").replace(/^mcp__retake__/, "");
        const inp = c.input ?? {};
        const what = name === "dry" || name === "run" || name === "render" || name === "receipts" || name === "read_manifest" ? `${name} ${inp.name ?? ""}${inp.preview === false ? " (final)" : ""}` : name === "scout" ? `scout ${inp.url ?? ""}` : name === "read_project" ? `read ${inp.dir ?? ""}` : name === "edit" ? `edit ${inp.name ?? ""} (${(inp.edits as unknown[] | undefined)?.length ?? 0} change${((inp.edits as unknown[] | undefined)?.length ?? 0) === 1 ? "" : "s"})` : name;
        push(s, "tool", what);
      } else if (c.type === "text" && c.text && c.text.trim()) {
        push(s, "thought", c.text.trim().slice(0, 300));
      }
    }
  } else if (type === "result") {
    s.cost = Number(d.total_cost_usd ?? 0) || undefined;
    s.turns = Number(d.num_turns ?? 0) || undefined;
    if (d.subtype && d.subtype !== "success") push(s, "line", `✗ operator stopped: ${d.subtype}`);
  } else if (type === "item" || type === "event") {
    // codex --json shapes vary; surface text items
    const it = d.item as { type?: string; text?: string } | undefined;
    if (it?.text) push(s, "thought", it.text.slice(0, 300));
  }
}

// --- pending questions / approvals ------------------------------------------

export function addPending(s: Session, kind: Pending["kind"], text: string, detail?: string): Pending {
  const p: Pending = { id: "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), kind, text, detail, answered: false, at: Date.now() };
  s.pending.push(p);
  push(s, "pending", p);
  return p;
}
export function answerPending(s: Session, id: string, answer: string): boolean {
  const p = s.pending.find((x) => x.id === id);
  if (!p) return false;
  p.answered = true; p.answer = answer;
  push(s, "answered", { id, answer });
  return true;
}
export function markDone(s: Session, summary: string, demo?: string) { s.summary = summary; s.demo = demo; push(s, "line", `✓ ${summary}`); }
export function stopSession(s: Session) { s.proc?.kill("SIGTERM"); }
