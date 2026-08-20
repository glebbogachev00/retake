/**
 * Starting the person's app — offered, never assumed.
 *
 * Retake records web apps, so a dead port is a common dead end. It can offer
 * to run the project's own dev script, but it must never do that on its own:
 * "record my app" quietly becoming "run commands on my machine" is the one
 * thing that would make the tool untrustworthy. So this module only provides
 * the mechanism; the click lives in the UI.
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

/** Start it and wait until something actually answers. Reports the real port. */
export async function startApp(opts: { dir: string; command: string; expectUrl?: string; seconds?: number; onProgress?: Progress }): Promise<StartResult> {
  const cwd = path.resolve(opts.dir.replace(/^~/, os.homedir()));
  const key = `${cwd}::${opts.command}`;
  const existing = started.get(key);
  if (existing && existing.url && (await answers(existing.url))) return { ok: true, url: existing.url, pid: existing.pid, log: "" };

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

  // Phase 1 — find the port. A dev server opens it within seconds and usually
  // announces it in the log; it may not be able to answer for minutes yet.
  const portUntil = Date.now() + 45_000;
  let port = opts.expectUrl ? Number(new URL(opts.expectUrl).port || 80) : 0;
  while (Date.now() < portUntil) {
    if (child.exitCode !== null) return { ok: false, log: tail(), why: `the command exited (${child.exitCode}) — see the log` };
    if (port && (await portOpen(port))) break;
    const m = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):(\d{2,5})/.exec(tail());
    if (m && (await portOpen(Number(m[1])))) { port = Number(m[1]); break; }
    const fresh = listeningPorts().filter((p) => !before.has(p));
    if (fresh.length) { port = fresh[0]; break; }
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  if (!port || !(await portOpen(port))) return { ok: false, log: tail(), why: "nothing opened a port within 45s — check the log" };

  const url = `http://localhost:${port}`;
  say(`Port ${port} is open — waiting for the first page to build…`);

  // Phase 2 — be patient. A cold Next/Vite dev server compiles on the first
  // request, and on a loaded machine that is minutes, not seconds. Failing at
  // two seconds (as this used to) reports a working app as dead.
  const answerUntil = Date.now() + (opts.seconds ?? 300) * 1000;
  while (Date.now() < answerUntil) {
    if (child.exitCode !== null) return { ok: false, log: tail(), why: `the command exited (${child.exitCode}) — see the log` };
    if (await answers(url, 20_000)) {
      started.set(key, { pid: child.pid ?? 0, url, logFile });
      return { ok: true, url, pid: child.pid ?? undefined, log: tail() };
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
