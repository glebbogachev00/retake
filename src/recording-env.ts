/**
 * The recording environment — the thing that has to be true before a camera
 * is worth starting.
 *
 * Six takes were lost in one session, and not one of them to a bug in the
 * recorder. They were lost to the environment: an app pointed at the owner's
 * real cloud store, a browser tab still attached to the instance that pushed
 * that owner's data back into it, a dev server caching state so the seed only
 * applied at boot, a previous run's leftovers inherited as the starting state,
 * and two takes racing over one output folder.
 *
 * Every one of those is cheap to assert and expensive to discover from a
 * frame. So: declare the environment, bring it up, prove it, then record. A
 * take that starts without proof is a take you will watch before you learn
 * anything — and the watching is the slow part.
 */
import { launchChromium } from "./browser-home.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { z } from "zod";
import YAML from "yaml";

export const EnvSpec = z.object({
  name: z.string().min(1),
  /** The app under test. */
  start: z.object({
    command: z.string().min(1),
    cwd: z.string().min(1),
    port: z.number().int().min(1024).max(65535),
    /** Variables forced for the recording. An empty string BLANKS one, which
        is how a cloud token in .env.local stops reaching the real account —
        an unset-looking value the app's own "is it configured" check fails. */
    env: z.record(z.string(), z.string()).default({}),
    /** How long to wait for the port to answer. Cold Next starts are slow. */
    readySeconds: z.number().int().min(5).max(600).default(120),
  }),
  /** What makes two runs start the same. */
  reset: z.object({
    /** Restart the app before every take. Required for any app that caches
        its state in server memory, which is most of them: without it the
        second take inherits whatever the first one left behind. */
    restart: z.boolean().default(true),
    /** Directories emptied before the app starts. */
    clear: z.array(z.string()).default([]),
  }).prefault({}),
  /** The app's starting state, written BEFORE the app starts. A seed written
      to a running app races its cache: the server had already answered
      "empty" to the environment's own check and kept answering it, so the
      board the demo needed never arrived. Seeded first, the app boots with it. */
  seed: z.object({ from: z.string(), to: z.string() }).optional(),
  /** Proof, checked after the app is up and the seed is written. `absent` is
      the one that catches real data leaking in — you cannot assert the absence
      of something you did not think of, so name the thing that must not be
      there. */
  expect: z.object({
    path: z.string().default("/"),
    present: z.array(z.string()).default([]),
    absent: z.array(z.string()).default([]),
    seconds: z.number().int().min(1).max(120).default(30),
  }).optional(),
});
export type EnvSpec = z.infer<typeof EnvSpec>;

export function loadEnvSpec(file: string): EnvSpec {
  const raw = YAML.parse(fs.readFileSync(file, "utf8")) as unknown;
  const parsed = EnvSpec.safeParse(raw);
  if (!parsed.success) throw new Error(`${path.relative(process.cwd(), file)} is not a valid environment — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

const home = (p: string) => p.replace(/^~/, os.homedir());

export function portBusy(port: number): boolean {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 3000 });
    return out.trim().length > 0;
  } catch { return false; }
}

export function pidsOnPort(port: number): number[] {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", timeout: 3000 });
    return out.split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
  } catch { return []; }
}

async function answers(url: string, ms = 2500): Promise<boolean> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.status < 500; } catch { return false; }
}

export function stopEnvironment(spec: EnvSpec, log: (l: string) => void): void {
  const pids = pidsOnPort(spec.start.port);
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  if (pids.length) log(`  stopped ${pids.length} process${pids.length === 1 ? "" : "es"} on :${spec.start.port}`);
}

export type Brought = { url: string; logFile: string; restarted: boolean };

export async function bringUp(spec: EnvSpec, log: (l: string) => void): Promise<Brought> {
  const url = `http://localhost:${spec.start.port}`;
  const cwd = home(spec.start.cwd);
  if (!fs.existsSync(cwd)) throw new Error(`no such directory: ${cwd}`);

  let restarted = false;
  if (spec.reset.restart && portBusy(spec.start.port)) {
    log(`  restarting :${spec.start.port} — this app caches its board in server memory, so a seed written to a RUNNING server is ignored and take two inherits take one`);
    stopEnvironment(spec, log);
    await new Promise((r) => setTimeout(r, 2500));
    restarted = true;
  }

  for (const dir of spec.reset.clear) {
    const d = path.isAbsolute(home(dir)) ? home(dir) : path.join(cwd, home(dir));
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
    log(`  cleared ${d}`);
  }

  if (spec.seed) {
    const to = path.isAbsolute(home(spec.seed.to)) ? home(spec.seed.to) : path.resolve(home(spec.seed.to));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.resolve(home(spec.seed.from)), to);
    log(`  seeded ${to} — before the app starts, so it boots with it`);
  }

  if (!portBusy(spec.start.port)) {
    const logFile = path.join(os.tmpdir(), `retake-env-${spec.name}.log`);
    const out = fs.openSync(logFile, "w");
    // The blanked variables are the whole point: .env files are read by the
    // app AFTER the process environment, so an explicit "" here beats a real
    // token sitting in .env.local.
    const child = spawn("/bin/bash", ["-lc", spec.start.command], {
      cwd, detached: true, stdio: ["ignore", out, out],
      env: { ...process.env, ...spec.start.env },
    });
    child.unref();
    log(`  started: ${spec.start.command}  (log: ${logFile})`);
    const deadline = Date.now() + spec.start.readySeconds * 1000;
    while (Date.now() < deadline) {
      if (await answers(url)) return { url, logFile, restarted };
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`${spec.name} did not answer on ${url} within ${spec.start.readySeconds}s — see ${logFile}`);
  }
  if (!(await answers(url))) throw new Error(`something holds :${spec.start.port} but does not answer — stop it, or point the environment elsewhere`);
  return { url, logFile: "", restarted };
}

export type Verdict = { ok: boolean; lines: string[] };

/** Prove it, with a real browser, before the camera is worth starting. */
export async function verify(spec: EnvSpec, log: (l: string) => void): Promise<Verdict> {
  if (!spec.expect) return { ok: true, lines: ["no expectations declared — nothing was proven"] };
  const url = `http://localhost:${spec.start.port}${spec.expect.path}`;
  const browser = await launchChromium();
  const lines: string[] = [];
  let ok = true;
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: spec.expect.seconds * 1000 });
    for (const sel of spec.expect.present) {
      try {
        await page.waitForSelector(sel, { timeout: spec.expect.seconds * 1000, state: "attached" });
        lines.push(`  pass  present: ${sel}`);
      } catch { ok = false; lines.push(`  FAIL  missing: ${sel}`); }
    }
    for (const sel of spec.expect.absent) {
      const n = await page.locator(sel).count();
      if (n === 0) lines.push(`  pass  absent: ${sel}`);
      else { ok = false; lines.push(`  FAIL  present but must not be (${n}): ${sel} — something real reached this instance`); }
    }
  } finally {
    await browser.close();
  }
  for (const l of lines) log(l);
  return { ok, lines };
}

/** Nothing else may be driving the app while it is being recorded. */
export function exclusivity(outDir: string): string | null {
  const lock = path.join(outDir, ".lock");
  if (fs.existsSync(lock)) return `${path.relative(process.cwd(), outDir)} is locked by another take — two runs writing one folder is how a render loses its own file mid-write`;
  return null;
}
