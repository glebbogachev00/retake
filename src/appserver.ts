/**
 * Starting the person's app after an explicit Retake workflow requests it.
 *
 * Retake records web apps, so a dead port is a common dead end. The UI invokes
 * this only after the person selects a project and asks Retake to scan or
 * record it. External agents keep a separate opt-in gate in operator/tools.ts.
 *
 * The hard part is not spawning — it is knowing WHICH port. Next and Vite take
 * the next free one and say so once, in their log. So we watch the log and the
 * set of listening ports, and only report success when something answers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";

export type StartOffer = { command: string; script: string; dir: string };
export type StartResult = { ok: boolean; url?: string; pid?: number; log: string; why?: string };
export type Progress = (line: string) => void;

/** Processes this server started, so it can stop them and not double-start. */
const started = new Map<string, { pid: number; url?: string; logFile: string }>();
export const startedApps = () => [...started.entries()].map(([k, v]) => ({ key: k, ...v }));

export function listeningPorts(): number[] {
  try {
    const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8", timeout: 3000 });
    const ports = new Set<number>();
    for (const line of out.split("\n")) { const m = /:(\d{4,5})\s+\(LISTEN\)/.exec(line); if (m) ports.add(Number(m[1])); }
    return [...ports].filter((p) => p >= 1024 && p < 65535).sort((a, b) => a - b);
  } catch { return []; }
}

export async function answers(url: string, ms = 2500): Promise<boolean> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.status < 500; } catch { return false; }
}

/** Is something holding the port open? Cheap, and true long before a dev
    server can actually answer — the two are minutes apart on a cold start. */
export function portOpen(port: number, ms = 900): Promise<boolean> {
  return new Promise((done) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const end = (v: boolean) => { sock.destroy(); done(v); };
    sock.setTimeout(ms);
    sock.once("connect", () => end(true));
    sock.once("timeout", () => end(false));
    sock.once("error", () => end(false));
  });
}

export async function waitForUrl(url: string, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (await answers(url, 2000)) return true; await new Promise((ok) => setTimeout(ok, 900)); }
  return false;
}

/** Modern Next prints every useful fact on separate lines when the same
    project is already running. Prefer the last live localhost URL: the first
    one can be the short-lived port from the failed second launch. */
function alreadyRunningHint(log: string, cwd: string): { url: string; pid?: number } | null {
  if (!/already running/i.test(log)) return null;
  const urls = [...log.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}/g)].map((m) => m[0]);
  const dir = /^- Dir:\s+(.+)$/m.exec(log)?.[1]?.trim();
  if (dir && path.resolve(dir) !== cwd) return null;
  const pid = Number(/^- PID:\s+(\d+)$/m.exec(log)?.[1] || 0) || undefined;
  const url = [...new Set(urls)].at(-1);
  return url ? { url, pid } : null;
}

/** The project's own way of starting itself. We do not invent commands. */
export function startOffer(dir: string): StartOffer | null {
  const root = path.resolve(dir.replace(/^~/, os.homedir()));
  const pkgFile = path.join(root, "package.json");
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      for (const name of ["dev", "start", "serve", "preview"]) {
        if (scripts[name]) return { command: `npm run ${name}`, script: scripts[name], dir: root };
      }
    } catch { /* fall through */ }
  }
  // Vercel-style projects with no package.json (static + edge functions).
  if (fs.existsSync(path.join(root, "vercel.json")) || fs.existsSync(path.join(root, "api"))) {
    return { command: "vercel dev", script: "vercel dev", dir: root };
  }
  return null;
}

/** A port nothing is listening on, walking up from a sensible base. */
async function freePort(from = 3200): Promise<number> {
  const busy = new Set(listeningPorts());
  for (let p = from; p < from + 60; p++) if (!busy.has(p) && !(await portOpen(p, 300))) return p;
  return from + 61;
}

/** Say the same command again, but on a port of our choosing. Dev servers
    disagree about flags and agree about $PORT, so we set both where we can. */
function onPort(command: string, port: number): string {
  const flagged = /\b(next|vite|astro|nuxt|remix|ng|serve|http-server)\b/.test(command) && !/\bnpm run\b/.test(command)
    ? `${command} --port ${port}`
    : command;
  return `PORT=${port} ${flagged}`;
}

function withWebpack(command: string): string {
  if (/\b--webpack\b/.test(command)) return command;
  return /\bnpm run\b/.test(command) ? `${command} -- --webpack` : `${command} --webpack`;
}

/** A retried command is still the same app. Keep one map entry so a second
    request reuses the process we moved instead of starting it again. */
function startKey(cwd: string, command: string): string {
  let canonical = command;
  if (/^PORT=\d+\s+/.test(canonical)) canonical = canonical.replace(/^PORT=\d+\s+/, "").replace(/\s+--port\s+\d+$/, "");
  return `${cwd}::${canonical}`;
}

/** Start it and wait until something actually answers. Reports the real port. */
export async function startApp(opts: { dir: string; command: string; expectUrl?: string; seconds?: number; noRetry?: boolean; restartedExisting?: boolean; webpackFallback?: boolean; onProgress?: Progress }): Promise<StartResult> {
  const cwd = path.resolve(opts.dir.replace(/^~/, os.homedir()));
  const key = startKey(cwd, opts.command);
  const existing = started.get(key);
  if (existing && existing.url && (await answers(existing.url))) return { ok: true, url: existing.url, pid: existing.pid, log: "" };

  // Do this before spawning. Otherwise an already-open expected port can win
  // the readiness race and make us report somebody else's process as the app
  // we just started, before our child has time to print EADDRINUSE.
  if (opts.expectUrl && !opts.noRetry) {
    const expected = Number(new URL(opts.expectUrl).port || 80);
    if (await portOpen(expected, 300)) {
      const next = await freePort();
      opts.onProgress?.(`Port ${expected} is already in use — starting on ${next} instead.`);
      return startApp({ ...opts, command: onPort(opts.command, next), expectUrl: `http://localhost:${next}`, noRetry: true });
    }
  }

  const before = new Set(listeningPorts());
  const logFile = path.join(os.tmpdir(), `retake-app-${Date.now()}.log`);
  const out = fs.openSync(logFile, "a");
  // A login shell so nvm/asdf/volta shims are on PATH, and its own process
  // group so stopping it takes the whole tree with it.
  const child = spawn("/bin/sh", ["-lc", opts.command], { cwd, env: process.env, stdio: ["ignore", out, out], detached: true });
  child.unref();
  started.set(key, { pid: child.pid ?? 0, logFile });

  const tail = () => { try { return fs.readFileSync(logFile, "utf8").split("\n").slice(-14).join("\n"); } catch { return ""; } };
  const say = opts.onProgress ?? (() => {});
  const handleExisting = async (log: string): Promise<StartResult | null> => {
    const hint = alreadyRunningHint(log, cwd);
    if (!hint) return null;
    if (await answers(hint.url, 8000)) {
      try { process.kill(-(child.pid ?? 0), "SIGTERM"); } catch { /* failed launch already ended */ }
      say(`It is already running at ${hint.url} — using that.`);
      started.set(key, { pid: 0, url: hint.url, logFile });
      return { ok: true, url: hint.url, log };
    }
    if (!hint.pid || opts.restartedExisting) return { ok: false, log, why: `the existing server at ${hint.url} is not responding` };
    say(`The existing server at ${hint.url} is not responding — restarting it.`);
    try { process.kill(hint.pid, "SIGTERM"); } catch { return { ok: false, log, why: `the existing server at ${hint.url} could not be stopped` }; }
    const port = Number(new URL(hint.url).port || 80);
    for (let i = 0; i < 12 && (await portOpen(port, 400)); i++) await new Promise((ok) => setTimeout(ok, 500));
    if (await portOpen(port, 400)) {
      say(`The stale server did not stop cleanly — force-stopping PID ${hint.pid}.`);
      try { process.kill(hint.pid, "SIGKILL"); } catch { /* verify the port below */ }
      for (let i = 0; i < 8 && (await portOpen(port, 300)); i++) await new Promise((ok) => setTimeout(ok, 350));
    }
    if (await portOpen(port, 400)) return { ok: false, log, why: `the existing server at ${hint.url} did not stop` };
    try { process.kill(-(child.pid ?? 0), "SIGTERM"); } catch { /* failed launch already ended */ }
    const restarted = await startApp({ ...opts, expectUrl: hint.url, noRetry: true, restartedExisting: true });
    if (restarted.ok && restarted.url) started.set(key, { pid: restarted.pid ?? 0, url: restarted.url, logFile });
    return restarted;
  };

  // Phase 1 — find the port. A dev server opens it within seconds and usually
  // announces it in the log; it may not be able to answer for minutes yet.
  const portUntil = Date.now() + 45_000;
  let port = opts.expectUrl ? Number(new URL(opts.expectUrl).port || 80) : 0;
  while (Date.now() < portUntil) {
    const log = tail();
    const existingResult = await handleExisting(log);
    if (existingResult) return existingResult;
    if (child.exitCode !== null) {
      if (/EADDRINUSE|address already in use|port \d+ is (?:already )?in use|another .* is already running/i.test(log) && !opts.noRetry) {
        const p2 = await freePort();
        say(`That port is taken — trying ${p2} instead.`);
        return startApp({ ...opts, command: onPort(opts.command, p2), expectUrl: `http://localhost:${p2}`, noRetry: true, onProgress: opts.onProgress });
      }
      return { ok: false, log, why: `the command exited (${child.exitCode}) — see the log` };
    }
    if (port && (await portOpen(port))) break;
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/.exec(tail());
    if (m && (await portOpen(Number(m[1])))) { port = Number(m[1]); break; }
    const fresh = listeningPorts().filter((p) => !before.has(p));
    if (fresh.length) { port = fresh[0]; break; }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  if (!port || !(await portOpen(port))) {
    const log = tail();
    // Two things a dev server says when it will not start, and both have a
    // better answer than "failed". If it is already running, that is the app
    // the person wanted — use it. If the port is simply taken, move over.
    const existingResult = await handleExisting(log);
    if (existingResult) return existingResult;
    const taken = /EADDRINUSE|address already in use|port \d+ is (?:already )?in use|another .* is already running/i.test(log);
    if (taken && !opts.noRetry) {
      const p2 = await freePort();
      say(`Something already holds that port — trying ${p2} instead.`);
      try { process.kill(-(child.pid ?? 0), "SIGTERM"); } catch { /* already gone */ }
      return startApp({ ...opts, command: onPort(opts.command, p2), expectUrl: `http://localhost:${p2}`, noRetry: true, onProgress: opts.onProgress });
    }
    return { ok: false, log, why: "nothing opened a port within 45s — check the log" };
  }

  const url = `http://localhost:${port}`;
  say(`Port ${port} is open — waiting for the first page to build…`);

  // Phase 2 — be patient. A cold Next/Vite dev server compiles on the first
  // request, and on a loaded machine that is minutes, not seconds. Failing at
  // two seconds (as this used to) reports a working app as dead.
  const answerUntil = Date.now() + (opts.seconds ?? 300) * 1000;
  const answerStarted = Date.now();
  while (Date.now() < answerUntil) {
    const log = tail();
    const existingResult = await handleExisting(log);
    if (existingResult) return existingResult;
    if (child.exitCode !== null) return { ok: false, log: tail(), why: `the command exited (${child.exitCode}) — see the log` };
    if (await answers(url, 20_000)) {
      started.set(key, { pid: child.pid ?? 0, url, logFile });
      return { ok: true, url, pid: child.pid ?? undefined, log: tail() };
    }
    if (!opts.webpackFallback && Date.now() - answerStarted > 25_000 && /Next\.js[\s\S]*\(Turbopack\)/i.test(log)) {
      say("The Turbopack server opened a port but did not serve the first page — retrying with webpack.");
      try { process.kill(-(child.pid ?? 0), "SIGTERM"); } catch { /* verify below */ }
      for (let i = 0; i < 12 && (await portOpen(port, 350)); i++) await new Promise((ok) => setTimeout(ok, 450));
      if (await portOpen(port, 350)) { try { process.kill(-(child.pid ?? 0), "SIGKILL"); } catch { /* retry reports a conflict if still alive */ } }
      const fallback = await startApp({ ...opts, command: onPort(withWebpack(opts.command), port), expectUrl: url, noRetry: true, webpackFallback: true });
      if (fallback.ok && fallback.url) started.set(key, { pid: fallback.pid ?? 0, url: fallback.url, logFile });
      return fallback;
    }
    say("Still building…");
  }
  return { ok: false, log: tail(), why: `it opened ${url} but never finished building — check the log` };
}

export function stopApp(key: string): boolean {
  const s = started.get(key);
  if (!s?.pid) return false;
  try { process.kill(-s.pid, "SIGTERM"); } catch { try { process.kill(s.pid, "SIGTERM"); } catch { return false; } }
  started.delete(key);
  return true;
}
