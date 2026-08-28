/**
 * Runs a manifest against a real browser and produces the raw take:
 * a video (via testreel's recordPage — cursor, ripples, zoom, chrome, mp4),
 * screenshots, and a timeline of every step with wall-clock offsets.
 *
 * The timeline is what makes captions and the proof log exact rather than
 * guessed: for AI-driven apps the next screen arrives whenever the model
 * answers, so no one can script timings up front.
 */
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { beginProgress, setPhase } from "./progress.js";
import { describeWait, waitForStep } from "./waiting.js";
import path from "node:path";
import { execFileSync, execSync, spawn } from "node:child_process";
import YAML from "yaml";
import { chromium, type BrowserContext, type Page } from "playwright";
import { recordPage, moveCursorToPoint, type PageRecorder } from "testreel";
import { expandEnv, resolve, type Manifest, type Point, type Resolved, type Seed, type Step, type Stub } from "./manifest.js";
import { ffmpegBin, videoDuration } from "./render.js";

export type TimelineEntry = {
  index: number;
  action: Step["action"];
  summary: string;
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  ok: boolean;
  error?: string;
  /** Scene-only fields. */
  label?: string;
  caption?: string;
  holdMs?: number;
  /** What the page said at the moment a step failed (first 240 chars). */
  screen?: string;
  /** A full-page PNG of the failure, written next to the take. */
  screenshot?: string;
  /** Where the browser actually was when it failed. */
  url?: string;
  /** Where the camera looks (video-pixel box) and how far in. */
  camera?: { zoom: number; box: { x: number; y: number; width: number; height: number }; focus: string };
  /** Callout-only: the box the ring is drawn around (video px) and its label. */
  callout?: { box: { x: number; y: number; width: number; height: number }; label?: string; ms: number };
};

export type Take = {
  /** Errors the APP reported while the camera was rolling, with timestamps.
      An error still on screen at the end means the video ends broken. */
  pageErrors?: { at: number; text: string }[];
  video?: string;
  screenshots: string[];
  timeline: TimelineEntry[];
  /** Total seconds of recorded video, per the timeline. */
  duration: number;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  /** Seconds at the head of the video spent on navigation/seed/setup — render trims them. */
  trimBefore: number;
  /** Set when the polished path failed and the video is a raw fallback (no cursor overlay). */
  partial?: string;
  /** Recorded with `--brisk`: all the steps, none of the pacing. Every check
      that judges a finished cut has to know, or it fails a take that is doing
      exactly what was asked of it. */
  brisk?: boolean;
  /** The resolved preset the take was recorded with (render reads it). */
  quality: { preset: string; width: number; height: number; scale: number; fps: number };
  /** Hash of everything that shapes the recording — same hash → the raw take can be reused. */
  captureHash?: string;
  /** Wall-clock seconds the recording took (browser open → closed). */
  captureSec?: number;
  /** What the app's media queries saw (documentElement.clientWidth). */
  layoutWidth?: number;
  /** The CSS width of actual LAYOUT SPACE the content got — viewport ÷ scale.
      Measured to be the real constraint: at scale 2 a width:100% element gets
      half the room while the media queries still read full width, so a
      desktop layout comes out cramped rather than switching to mobile. */
  contentWidth?: number;
  /** Files the run downloaded, saved under outputs/<name>/downloads/. */
  downloads?: string[];
  /** Endpoints answered with canned data during this take. Named in the proof
      log so a stubbed demo can never quietly pass as a live one. */
  stubbed?: string[];
  /** How many requests each stub actually answered. Zero means the stub never
      matched anything — the take is showing live data where it meant to show
      canned, and nothing else about the run would say so. */
  stubHits?: Record<string, number>;
};

/** What the *recording* depends on — nothing that render can change afterwards.
    A scene's caption, hold and camera zoom are render-time, so editing them must
    not cost a new take; its label and camera focus are not, because the focus
    box is measured live while recording. */
export function captureHash(m: Manifest): string {
  const q = resolve(m);
  const steps = m.steps.map((s) => {
    if (s.action !== "scene") return s;
    const cam = s.camera;
    const focus = cam && typeof cam === "object" ? cam.focus ?? null : cam === "static" ? "static" : null;
    return { action: "scene", label: s.label, focus };
  });
  const h = createHash("sha1");
  h.update(JSON.stringify({ url: m.url, viewport: q.viewport, scale: q.scale, cursor: q.cursor, wait: m.waitForSelector, reduced: m.reducedMotion, auth: m.auth, seed: m.seed, stub: m.stub, setup: m.setup, steps, speed: m.speed, camera: m.camera, colorScheme: m.colorScheme }));
  return h.digest("hex").slice(0, 12);
}


/**
 * Can the last raw take be reused instead of opening the browser again?
 *
 * The capture hash is computed from the MANIFEST, so it cannot see how a take
 * was recorded — only what it recorded. Two takes of the same demo, one paced
 * and one brisk, hash identically. Without the flags below, `--reuse` would
 * quietly hand back a take with no pacing in it, or a fragment, as if it were
 * the finished thing.
 */
export function canReuse(prev: Take | null | undefined, m: Manifest): boolean {
  if (!prev) return false;
  if (!prev.captureHash || prev.captureHash !== captureHash(m)) return false;
  if (!prev.video || !fs.existsSync(prev.video)) return false;
  if (prev.partial) return false;   // a --from/--until fragment, or a run that fell over
  if (prev.brisk) return false;     // all the steps, none of the pacing
  return true;
}

/** The session a take should start from, and whether it is still good.
    Shared so `dry` starts signed in exactly when `run` would — a dry run
    against a logged-out app "proving" a manifest is a wasted take waiting
    to happen. */
export function authState(m: Manifest, manifestDir: string): { path: string | null; fresh: boolean } {
  const p = m.auth ? path.resolve(manifestDir, expandEnv(m.auth.storageState)) : null;
  const fresh = !!p && fs.existsSync(p) && (Date.now() - fs.statSync(p).mtimeMs) / 3.6e6 < (m.auth?.maxAgeHours ?? 72);
  return { path: p, fresh };
}

/** Everything injected into a page before it loads.
 *
 * ONE function, called by both the recorder and the dry run, because the
 * expensive failure in this tool is a green `dry` followed by a failed `run`
 * — and every knob only one of them applied was a way for dry to prove a
 * different app than run would film. A knob added here reaches both by
 * construction; a knob added to one call site is the bug this replaces. */
export async function applyPageSetup(context: BrowserContext, m: Manifest, q: Resolved): Promise<void> {
  // The page lays out at `scale`× (CSS zoom): the app sees a smaller viewport
  // and renders crisp into the full canvas. Coordinates testreel/Playwright
  // see are already video pixels, so cursor and clicks line up.
  // Scale via a <style> tag, not an inline attribute: React hydration diffs
  // element attributes against the server HTML, so style.zoom on <html> made
  // every React app report a hydration mismatch — with a dev badge in shot.
  if (q.scale !== 1) await context.addInitScript(`document.addEventListener("DOMContentLoaded",()=>{const st=document.createElement("style");st.textContent="html{zoom:${q.scale}}";document.head.appendChild(st)})`);
  // One page is what gets recorded, so keep the flow in it: window.open
  // navigates in place, and target=_blank is stripped as it appears. A demo
  // that spawned a second tab used to simply lose its subject.
  if (m.keepInTab) {
    await context.addInitScript(`
      (() => {
        const orig = window.open;
        window.open = function (url) { if (url) { location.href = String(url); return window; } return orig.apply(window, arguments); };
        const strip = (root) => { for (const a of root.querySelectorAll ? root.querySelectorAll('a[target="_blank"]') : []) a.removeAttribute('target'); };
        addEventListener('DOMContentLoaded', () => {
          strip(document);
          new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) strip(n); }).observe(document.documentElement, { childList: true, subtree: true });
        });
      })();
    `);
  }
    // Dev servers decorate themselves — Next's issues badge, Vite's error
  // overlay, webpack's. None of that belongs in a product video, and no
  // manifest should have to know about it.
  await context.addInitScript(`document.addEventListener("DOMContentLoaded",()=>{const st=document.createElement("style");st.textContent="nextjs-portal,#__next-build-watcher,vite-error-overlay,#webpack-dev-server-client-overlay,#react-refresh-overlay{display:none!important}";document.head.appendChild(st)})`);
}


/** The manifest's own readiness gate, with the wrong-app diagnosis attached.
    Both the recorder and `dry` wait on it: a dry run that starts stepping
    before the app has booted reports selector failures that are really a
    race, and it should refuse a wrong build for the same reason run does. */
export async function gateOnApp(page: Page, m: Manifest, outDir: string): Promise<void> {
  if (m.waitForSelector) {
    try {
      await page.waitForSelector(m.waitForSelector, { timeout: 20_000 });
    } catch {
      // Almost never a bad selector — almost always the wrong app on the
      // port: a stale dev server, a different build, a login wall, a
      // marketing page. Say THAT, with what is actually there.
      let saw = "", title = "";
      try { title = await page.title(); saw = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\s+/g, " ").trim().slice(0, 200); } catch { /* page gone */ }
      try { await page.screenshot({ path: path.join(outDir, "not-the-app.png"), fullPage: true }); } catch { /* ignore */ }
      throw new Error(
        `the app at ${m.url} is not what this manifest expects: waited 20s for \`${m.waitForSelector}\` and it never appeared.\n` +
        `  page title: ${title || "(none)"}\n` +
        `  on screen: ${saw ? `“${saw}”` : "(nothing)"}\n` +
        `  picture: ${path.relative(process.cwd(), path.join(outDir, "not-the-app.png"))}\n` +
        `  Usually the port is serving a different build or mode — restart the app and check the URL in a browser before re-running.`,
      );
    }
  }
}


/** Where a re-record actually has to start.
 *
 * Every take saves the manifest it used, so a later run can compare against
 * it and find the last scene whose preceding steps are byte-identical. Below
 * that point nothing about the recording changed, and `from: <that scene>`
 * records only what did.
 *
 * This exists because the capability was already there and nobody used it:
 * of four takes of one 251-step demo, the two that used `from` were mine and
 * the two the agent made were full re-records at twice the cost. A feature
 * nobody reaches for is worth less than one that speaks up. */
export function unchangedUpTo(m: Manifest, outDir: string): { scene: string; steps: number } | null {
  let prev: Manifest;
  try {
    const raw = fs.readFileSync(path.join(outDir, "manifest.used.yaml"), "utf8");
    prev = YAML.parse(raw) as Manifest;
  } catch { return null; }
  if (!prev?.steps?.length) return null;
  // Anything outside the steps changes the whole recording, so there is no
  // safe head to keep.
  const frame = (x: Manifest) => JSON.stringify({ url: x.url, viewport: x.viewport, scale: x.scale, seed: x.seed, stub: x.stub, setup: x.setup, auth: x.auth, speed: x.speed });
  if (frame(m) !== frame(prev)) return null;

  let same = 0;
  while (same < m.steps.length && same < prev.steps.length &&
         JSON.stringify(m.steps[same]) === JSON.stringify(prev.steps[same])) same++;
  if (same === m.steps.length && same === prev.steps.length) return null;  // nothing changed at all

  // Back up to the last scene at or before the divergence: a take can only
  // start at a scene, and starting later than the change would miss it.
  for (let i = Math.min(same, m.steps.length - 1); i >= 0; i--) {
    const st = m.steps[i];
    if (st.action === "scene" && st.label) return { scene: st.label, steps: i };
  }
  return null;
}

/**
 * The app never reached the state the demo starts from.
 *
 * Distinct from every other failure because it must not become a take. The
 * catch-all below turns anything that goes wrong into a `partial` and keeps
 * whatever video exists — right for a step that failed halfway through a real
 * recording, wrong here, where nothing worth keeping was ever recorded and
 * the honest answer is "this did not run".
 */
export class SetupFailed extends Error {}

export type RecordOptions = {
  /** Record up to the end of this scene label, then stop. */
  until?: string;
  /** Start the take at this scene. The steps before it still RUN — the app
      has to reach that state — but at full speed and off the clock, and the
      render trims them off the front. A demo whose ending changed stops
      costing its beginning. */
  from?: string;
  outDir: string;
  /**
   * Record the whole take without its pacing: every `pauseAfter` skipped and
   * every `wait` capped, exactly as the fast-forward half of `--from` already
   * does. The steps all run and all appear; only the holding still is gone.
   *
   * On a real demo, 317 of 509 seconds were spent holding — 62% of the take.
   * That pacing is right for a video somebody watches and pure cost while the
   * demo is still changing, and until now there was no way to pay for one
   * without the other.
   */
  brisk?: boolean;
  /** The caller already holds the folder lock. */
  locked?: boolean;
  headed?: boolean;
  skipSeed?: boolean;
  manifestDir: string;
  log?: (line: string) => void;
  /** Called as each step is performed, so a watcher can show how far in this
      is. The MCP run tool threw the log away entirely, which is why the
      window said "Recording…" and then nothing at all for sixteen minutes. */
  onProgress?: (p: { phase: "setup" | "recording" | "done" | "stuck"; step: number; total: number; label: string; quietSec?: number }) => void;

};

const noop = () => {};


/** The take's time ceiling: the manifest's own maxSeconds, else ≈10s per
    step plus explicit waits, never under 240s or over an hour. Used by the
    recorder and by check(), so the two can never disagree. */
export function capSecondsFor(m: Manifest): number {
  if (m.maxSeconds) return m.maxSeconds;
  const waits = m.steps.reduce((n, st) => n + (st.action === "wait" ? st.ms / 1000 : 0) + ((st as { pauseAfter?: number }).pauseAfter ?? 0) / 1000, 0);
  return Math.min(3600, Math.max(240, Math.round(m.steps.length * 10 + waits)));
}


/** What the LAST take of this demo actually cost, in seconds of wall clock.
 *
 * Measured, because estimating it does not work. Fitted against 31 real takes,
 * step count predicts capture time with ~33% mean error and is wrong in both
 * directions by 3x: an 11-step demo of a slow remote app took 221s while a
 * 105-step local one took 116s. What the app does between the steps is the
 * whole cost, and a manifest cannot know that. The previous take can. */
export function lastCaptureSeconds(outDir: string): number | null {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(outDir, "take.json"), "utf8")) as Take;
    return typeof t.captureSec === "number" && t.captureSec > 0 ? t.captureSec : null;
  } catch { return null; }
}

/** Long enough that a person should see a draft before the full take is spent. */
export const EXPENSIVE_TAKE_SECONDS = 150;

/** Roughly how many times the cursor will move on camera. */
/** Cursor moves per take. testreel's nested-if overlay died at ~45 (ffmpeg's
    parser stops at 98 levels); scripts/patch-testreel.mjs flattens those
    expressions, so the ceiling is now the size of the filter graph as one
    argv string — ~630 bytes a move against Linux's 128 KB per-argument cap. */
export const CURSOR_MOVE_LIMIT = 180;
export function cursorMoves(m: Manifest): number {
  return m.steps.filter((s) => ["click", "type", "fill", "hover", "scroll", "upload"].includes(s.action)).length;
}

/** A point, read from the page's own geometry. Playwright's locator engine
    refuses elements whose handlers intercept pointer events (Blockly's toolbox
    categories, for one); getBoundingClientRect does not care. */
export async function resolvePoint(page: Page, p: Point, timeout: number): Promise<{ x: number; y: number }> {
  if (typeof p === "object" && "x" in p) return { x: p.x, y: p.y };
  const selector = typeof p === "string" ? p : p.selector;
  const dx = typeof p === "string" ? 0 : p.dx;
  const dy = typeof p === "string" ? 0 : p.dy;
  // Playwright finds it (so :has-text and >> nth= work), the page measures it
  // (so an element whose handlers intercept pointer events still yields a
  // rect — locator.boundingBox() waits for visibility and can time out on
  // Blockly's toolbox).
  // Poll: a zero-size box usually means the panel is still animating in, not
  // that the selector is wrong.
  const until = Date.now() + timeout;
  let rect: { x: number; y: number; w: number; h: number } | null = null;
  while (Date.now() < until) {
    const handle = await page.locator(selector).first().elementHandle({ timeout: Math.max(500, until - Date.now()) });
    if (handle) {
      rect = await handle.evaluate((el) => { const r = (el as Element).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; });
      await handle.dispose();
      if (rect && (rect.w || rect.h)) break;
    }
    await page.waitForTimeout(250);
  }
  if (!rect) throw new Error(`no element for point target "${selector}"`);
  if (!rect.w && !rect.h) throw new Error(`point target "${selector}" never got a size (still hidden or collapsed?)`);
  return { x: rect.x + dx, y: rect.y + dy };
}

/** Press, move, release, with the cursor overlay following. testreel records
    cursor keyframes only for its own actions, so we log two of our own and let
    it animate between them while the page gets the many small moves it needs
    to believe a drag is happening. Two keyframes, so a drag costs the overlay
    what a click costs. */
export async function dragPoints(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, o: { steps: number; holdMs: number; durationMs: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (o.holdMs) await page.waitForTimeout(o.holdMs);
  await page.mouse.move(from.x + 8, from.y + 8);
  const per = Math.max(4, Math.round(o.durationMs / o.steps));
  for (let i = 1; i <= o.steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / o.steps, from.y + ((to.y - from.y) * i) / o.steps);
    await page.waitForTimeout(per);
  }
  await page.mouse.up();
}

async function performDrag(page: Page, step: Extract<Step, { action: "drag" }>, q: Resolved, timeout: number) {
  const from = await resolvePoint(page, step.from, timeout);
  const to = await resolvePoint(page, step.to, timeout);
  const opts = q.cursor === false ? undefined : { style: q.cursor.style, size: q.cursor.size };
  if (opts) await moveCursorToPoint(page, from.x, from.y, opts);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  if (step.holdMs) await page.waitForTimeout(step.holdMs);
  await page.mouse.move(from.x + 8, from.y + 8);   // cross the editor's drag threshold
  if (opts) void moveCursorToPoint(page, to.x, to.y, { ...opts, transitionMs: step.durationMs });
  const per = Math.max(8, Math.round(step.durationMs / step.steps));
  for (let i = 1; i <= step.steps; i++) {
    await page.mouse.move(from.x + ((to.x - from.x) * i) / step.steps, from.y + ((to.y - from.y) * i) / step.steps);
    await page.waitForTimeout(per);
  }
  await page.mouse.up();
}

/** Wait for a named resource lock (outputs/.locks/<name>), up to 10 min.
    A stale lock from a dead process is reclaimed after its owner is gone. */
async function acquireNamedLock(outRoot: string, name: string, log: (l: string) => void): Promise<() => void> {
  const dir = path.join(outRoot, ".locks");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.lock`);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = Date.now() + 10 * 60_000;
  let waited = false;
  while (Date.now() < until) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx" });
      if (waited) log(`lock "${name}": acquired`);
      return () => { try { if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
    } catch {
      const owner = Number(fs.readFileSync(file, "utf8").trim() || 0);
      if (!owner || !alive(owner)) { fs.rmSync(file, { force: true }); continue; }
      if (!waited) { log(`lock "${name}": another take (pid ${owner}) holds it — waiting so we do not wipe each other's state`); waited = true; }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`lock "${name}": still held after 10 minutes`);
}

export async function record(m: Manifest, opts: RecordOptions): Promise<Take> {
  let releaseNamed: (() => void) | null = null;
  const log = opts.log ?? noop;
  const startedAt = new Date().toISOString();
  fs.mkdirSync(opts.outDir, { recursive: true });

  // The caller (cli run) holds the folder lock across record + render; if it
  // did not, take it here for the recording at least.
  const ownLock = !opts.locked && acquireLock(opts.outDir);
  // Where this run is, on disk, for anything that wants to watch — including
  // a person who started it from a terminal and a window that was never told.
  beginProgress(opts.outDir, m.name);

  // Playwright writes its in-progress .webm to a private per-run dir, never to
  // the shared output dir, so nothing else can delete it mid-take.
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), `retake-${m.name}-`));
  const q = resolve(m);
  log(`preset ${q.name} · canvas ${q.width}×${q.height} · viewport ${q.viewport.width}×${q.viewport.height} @ ${q.fps}fps · page scale ${q.scale}×`);

  if (!opts.skipSeed) {
    setPhase(opts.outDir, { phase: "seeding", label: "putting the app in a known state" });
    if (m.lock) releaseNamed = await acquireNamedLock(path.dirname(opts.outDir), m.lock, log);
    for (const s of m.seed) await runFileOrCommandSeed(s, opts.manifestDir, log);
  }

  const browser = await chromium.launch({ headless: !opts.headed });
  const size = { ...q.viewport };
  // A saved session (auth.storageState) means the login already happened on an
  // earlier run: load it and the setup login steps can be skipped.
  const { path: statePath, fresh: stateFresh } = authState(m, opts.manifestDir);
  if (statePath) log(stateFresh ? `auth: reusing session ${path.relative(process.cwd(), statePath)}` : `auth: no fresh session — running setup to sign in`);
  // No session and nothing that could create one: stop here rather than record
  // a logged-out take that passes every check.
  if (statePath && !stateFresh && !(m.auth?.setup?.length)) throw new Error(`no fresh session at ${path.relative(process.cwd(), statePath)} and no auth.setup to sign in with — run \`retake signin ${path.relative(process.cwd(), path.join(opts.manifestDir, m.name + ".yaml"))}\` and log in once by hand, or add the sign-in steps under auth.setup`);
  const context = await browser.newContext({
    viewport: size,
    colorScheme: m.colorScheme,
    ...(m.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
    recordVideo: { dir: rawDir, size },
    ...(stateFresh && statePath ? { storageState: statePath } : {}),
  });
  await applyPageSetup(context, m, q);

  // Canned responses live in a map the route handler reads on every request, so
  // a `stub` step mid-demo swaps the answer without re-registering anything.
  // Keyed by method+url: a POST stub must not replace the GET stub on the same
  // path — they are different answers to different questions.
  const stubs = new Map<string, Stub>();
  const stubbed: string[] = [];
  // How many requests each stub actually answered. A stub that answered NONE
  // is the quiet failure: the take passes, the screen looks plausible, and it
  // is showing live data the demo was written to replace. Counting is free;
  // not counting cost someone a morning of reading screenshots.
  const stubHits = new Map<string, number>();
  const armStub = async (d: Stub) => {
    const key = `${d.method ?? "ANY"} ${d.url}`;
    const fresh = !stubs.has(key);
    stubs.set(key, d);
    if (!stubbed.includes(key)) stubbed.push(key);
    if (!stubHits.has(key)) stubHits.set(key, 0);
    if (!fresh) return;
    await context.route(d.url, async (route, request) => {
      const cur = stubs.get(key)!;
      if (cur.method && request.method().toUpperCase() !== cur.method.toUpperCase()) return route.fallback();
      stubHits.set(key, (stubHits.get(key) ?? 0) + 1);
      const body =
        cur.json !== undefined
          ? JSON.stringify(cur.json)
          : cur.from
            ? fs.readFileSync(path.resolve(opts.manifestDir, expandEnv(cur.from)), "utf8")
            : "{}";
      await route.fulfill({ status: cur.status ?? 200, contentType: cur.contentType, body });
    });
  };

  const timeline: TimelineEntry[] = [];
  const ctx: StepCtx = { outDir: opts.outDir, manifestDir: opts.manifestDir, downloads: [], stub: armStub };
  let ok = true;
  let partial: string | undefined;
  const pageErrors: { at: number; text: string }[] = [];
  let video: string | undefined;
  let screenshots: string[] = [];
  let layoutWidth: number | undefined;
  let contentWidth: number | undefined;
  let watchdog: NodeJS.Timeout | undefined;
  let lastStepAt = Date.now();
  let t0 = Date.now();
  let setupEnd = t0;
  let endMs = t0;
  const sec = (ms: number) => Math.round((ms / 1000) * 1000) / 1000;

  try {
    for (const d of m.stub) await armStub(d);
    if (m.stub.length) log(`stub: ${m.stub.map((d) => d.url).join(", ")}`);

    // Pre-warm the route (a dev server may compile for seconds on first hit) so
    // the recorded navigation is short and the video's start is predictable.
    await context.request.get(expandEnv(m.url)).catch(noop);
    const page = await context.newPage();
    if (process.env.RETAKE_PAGE_CONSOLE) page.on("console", (msg) => log(`  [page] ${msg.text().slice(0, 200)}`));
    // What the app itself said went wrong, with the moment it said it. A take
    // can pass every step and still END on "This page couldn\u2019t load" —
    // one did, and only frame-by-frame review caught it. Timestamped so
    // `check` can ask the only question that matters: was it still broken
    // when the video stopped?
    page.on("pageerror", (e) => pageErrors.push({ at: sec(Date.now() - t0), text: String(e.message ?? e).slice(0, 300) }));
    page.on("console", (msg) => { if (msg.type() === "error") pageErrors.push({ at: sec(Date.now() - t0), text: msg.text().slice(0, 300) }); });

    // --- setup phase (still inside the video; trimmed later by `trimBefore`) ---
    // Document first; idle only if it comes quickly. Busy public sites never
    // go network-idle, and the manifest's waitForSelector is the real gate.
    await page.goto(expandEnv(m.url), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => { /* see above */ });
    // Two different widths, and the difference is the whole trap.
    //
    // Measured, on a real navigation: under `html{zoom:2}` a width:100%
    // element gets 960 CSS px of LAYOUT SPACE while media queries still
    // report 1920. So a responsive app does not switch to its mobile layout —
    // it renders its DESKTOP layout squeezed into half the room, which is
    // why the result looks wrong in a way no breakpoint explains.
    //
    // Both numbers go in the proof log, because either one alone misleads.
    layoutWidth = await page.evaluate(() => document.documentElement.clientWidth).catch(() => undefined);
    contentWidth = Math.round((q.viewport.width) / q.scale);
    if (!opts.skipSeed) {
    setPhase(opts.outDir, { phase: "seeding", label: "putting the app in a known state" });
      for (const s of m.seed) {
        if (s.kind === "evaluate") await runEvaluateSeed(page, s, opts.manifestDir, log);
      }
    }
    await gateOnApp(page, m, opts.outDir);

    // Playwright's video begins at the first *painted* frame, not at newPage().
    // On a dev server that can be seconds later; if testreel's cursor overlay is
    // told the wrong start it draws every cursor move that many seconds late.
    const videoStartedAt = await firstPaintWallClock(page);
    t0 = videoStartedAt;

    if (q.scale !== 1) await page.evaluate((z) => { document.documentElement.style.zoom = String(z); }, q.scale);

    // Idle-hide fades are nested if()s in testreel's ffmpeg alpha expression;
    // past roughly sixty steps the nesting exceeds ffmpeg's parser and the
    // composite fails. Long demos get an always-visible cursor unless told
    // otherwise — the fade was never the point of the video.
    const cursorIdleHide = q.cursor === false ? undefined : q.cursor.idleHide;
    const rec = await recordPage(page, {
      outputDir: opts.outDir,
      name: m.name,
      clean: false,
      cursor: q.cursor === false ? false : { style: q.cursor.style, size: q.cursor.size, idleHideMs: q.cursor.idleHideMs, idleHide: cursorIdleHide },
      chrome: false,
      background: false,
      speed: m.speed,
      // webm: skip testreel's own H.264 pass — render.ts does the one clean encode.
      outputFormat: "webm",
      videoStartedAt,
    });

    // Sign-in steps run only when there is no fresh session to reuse; the rest
    // of `setup` always runs. (They were once the same list, which meant a
    // saved session silently skipped the steps that put the app on its opening
    // screen — a whole take of the wrong thing, with nothing in the log.)
    let authOk = true;
    for (const step of [...(stateFresh ? [] : (m.auth?.setup ?? [])).map((st) => ({ st, auth: true })), ...m.setup.map((st) => ({ st, auth: false }))]) {
      try {
        await runStep(rec, page, step.st, m, ctx);
      } catch (e) {
        if (step.auth) authOk = false;
        const why = (e as Error).message.split("\n")[0];
        log(`setup step failed: ${describe(step.st)} — ${why}`);

        // Evidence, at the instant, not reconstructed afterwards: what the
        // page was showing when the app failed to reach its starting state.
        let shot = "";
        try {
          shot = path.join(opts.outDir, step.auth ? "auth-failed.png" : "setup-failed.png");
          await page.screenshot({ path: shot, fullPage: true });
          log(`  picture of it: ${path.relative(process.cwd(), shot)}`);
        } catch { shot = ""; }
        try { log(`  url: ${page.url()}`); } catch { /* page gone */ }

        // And it stops. This used to be logged and then ignored — the take
        // went on to record an app that had never reached the screen the demo
        // is about, and reported `ok: true` for it. A sign-in failure is
        // always fatal; anything else obeys `onFail`, which defaults to stop.
        if (step.auth) {
          throw new SetupFailed(`signing in failed: ${describe(step.st)} — ${why}. Nothing was recorded, and no session was saved.${shot ? ` See ${path.basename(shot)}.` : ""}`);
        }
        if (m.onFail !== "continue") {
          throw new SetupFailed(`setup failed: ${describe(step.st)} — ${why}. The app never reached its starting state, so nothing was recorded.${shot ? ` See ${path.basename(shot)}.` : ""} Set \`onFail: continue\` if this step is genuinely optional.`);
        }
        log("  onFail: continue — carrying on with an app that may not be where the demo expects it");
      }
    }
    // Persist the signed-in session so later takes skip the login entirely —
    // but never a broken one: saving after a failed login poisons every later
    // run, which then "reuses" a logged-out session and records the login
    // page while believing it is signed in.
    if (statePath && !stateFresh && authOk) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      await context.storageState({ path: statePath });
      try { fs.chmodSync(statePath, 0o600); } catch { /* windows */ }
      log(`auth: saved session → ${path.relative(process.cwd(), statePath)}`);
    } else if (statePath && !stateFresh) {
      log("auth: a sign-in step failed — NOT saving this session");
    }
    setupEnd = Date.now();

    const capSeconds = capSecondsFor(m);
    // testreel draws the cursor with one nested if() per move, and ffmpeg's
    // expression parser stops at 98 levels — about 49 moves. Past that the
    // overlay silently fails and the video ships with no cursor at all.
    const moves = cursorMoves(m);
    if (q.cursor !== false && moves > CURSOR_MOVE_LIMIT) log(`cursor: ~${moves} cursor moves — past ~${CURSOR_MOVE_LIMIT} the cursor filter no longer fits in one ffmpeg argument and the overlay may be MISSING. Split the demo (a viewer wants chapters anyway), or set cursor: false to be honest about it.`);
    // A take can stop making progress without failing: a step inside its own
    // timeout, an app that never answers, a wait that will not resolve. The
    // step timeout eventually fires and maxSeconds eventually fires, but in
    // between there is a long silence with nothing saying anything is wrong.
    // This says it — it does not intervene, because a slow app is not a
    // broken one and only the person watching can tell the difference.
    lastStepAt = Date.now();
    let toldStuck = false;
    const QUIET_MS = 90_000;
    watchdog = setInterval(() => {
      const quiet = Date.now() - lastStepAt;
      if (quiet < QUIET_MS) { toldStuck = false; return; }
      if (toldStuck) return;
      toldStuck = true;
      const secs = Math.round(quiet / 1000);
      log(`⚠ no step has completed in ${secs}s — the app may be stuck, or this step may just be slow`);
      opts.onProgress?.({ phase: "stuck", step: 0, total: m.steps.length, label: `nothing for ${secs}s`, quietSec: secs });
    }, 15_000);
    watchdog.unref?.();

    let pastUntil = false;
    // --from <scene>: everything before it still runs (the app must reach that
    // state) but at full speed, and `trimBefore` moves to the moment it lands,
    // so none of it is in the finished video. Re-recording only the tail.
    let fastForward = !!opts.from && m.steps.some((st) => st.action === "scene" && st.label === opts.from);
    if (opts.from && !fastForward) throw new Error(`--from "${opts.from}": no scene with that label. Scenes here: ${m.steps.filter((st) => st.action === "scene").map((st) => (st as { label: string }).label).join(", ") || "(none)"}`);
    if (fastForward) log(`fast-forwarding to scene "${opts.from}" — the steps before it run but are not in the video`);
    if (opts.brisk) log("brisk: every pause skipped and every wait capped — the steps are all here, the pacing is not");
    for (const [i, step] of m.steps.entries()) {
      if (fastForward && step.action === "scene" && step.label === opts.from) {
        fastForward = false;
        setupEnd = Date.now();          // the take starts HERE
        // A fragment, like --until: say so, or every check that judges a
        // whole video (length, scene count) fails a take that is working
        // exactly as asked.
        partial = `recorded from scene "${opts.from}" (from) — a fragment for iteration, not a finished cut`;
        log(`▶ recording from "${opts.from}"`);
      }
      // --until <scene>: record that scene in full, stop at the next one.
      if (opts.until && step.action === "scene") {
        if (pastUntil) { partial = `stopped after scene "${opts.until}" (until)`; log(`■ ${partial}`); break; }
        if (step.label === opts.until) pastUntil = true;
      }
      // Fast for the head of a --from, or for the whole take when asked.
      ctx.fast = fastForward || !!opts.brisk;
      const start = Date.now();
      const entry: TimelineEntry = {
        index: i,
        action: step.action,
        summary: describe(step),
        start: sec(start - t0),
        end: 0,
        ok: true,
      };
      if (step.action === "callout") {
        // Resolve the box now; the ring itself is drawn at render time.
        const target = step.selector ?? step.at!;
        const c = await resolvePoint(page, target, step.timeout ?? 10_000);
        const half = typeof target === "string" || !("x" in (target as object))
          ? await page.locator((typeof target === "string" ? target : (target as { selector: string }).selector)).first().evaluate((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; }).catch(() => ({ w: 48, h: 48 }))
          : { w: 48, h: 48 };
        entry.callout = { box: { x: c.x - half.w / 2, y: c.y - half.h / 2, width: half.w, height: half.h }, label: step.label, ms: step.ms };
      }
      if (step.action === "scene") {
        entry.label = step.label;
        entry.caption = step.caption;
        entry.holdMs = step.holdMs;
        entry.camera = await resolveCamera(page, m, q, step, i);
      }
      log(`[${String(i).padStart(2, "0")}] ${entry.summary}${entry.camera ? ` · camera ${entry.camera.zoom}× on ${entry.camera.focus}` : ""}`);
      lastStepAt = Date.now();
      opts.onProgress?.({ phase: "recording", step: i + 1, total: m.steps.length, label: entry.summary });
      setPhase(opts.outDir, { phase: "recording", step: i + 1, of: m.steps.length, label: entry.summary });
      // A resume point on disk, so a take that dies is not a take lost. It
      // survives a kill because it is written as it goes, not at the end —
      // and `--from <that scene>` re-records only what came after it.
      if (step.action === "scene" && step.label) {
        try {
          fs.writeFileSync(path.join(opts.outDir, "reached.json"), JSON.stringify({
            demo: m.name, scene: step.label, step: i + 1, of: m.steps.length, at: new Date().toISOString(),
          }));
        } catch { /* a resume hint is a courtesy, never a reason to fail */ }
      }
      try {
        await runStep(rec, page, step, m, ctx);
      } catch (e) {
        ok = false;
        entry.ok = false;
        entry.error = (e as Error).message.split("\n")[0];
        // What the page actually showed at the moment of failure is worth
        // more than the error: it is how a reader (or agent) sees that the
        // login never happened, or the modal never closed.
        try { entry.screen = (await page.evaluate(() => document.body?.innerText ?? "")).replace(/\s+/g, " ").trim().slice(0, 240); } catch { /* page gone */ }
        // A picture of the moment it broke. Every diagnosis anyone has made
        // of a failed take came from pulling frames out of the video by hand;
        // this is that, for free, at the exact instant.
        let shot = "";
        try {
          shot = path.join(opts.outDir, "failed-step.png");
          await page.screenshot({ path: shot, fullPage: true });
          entry.screenshot = "failed-step.png";
        } catch { shot = ""; }
        try { entry.url = page.url(); } catch { /* page gone */ }
        log(`     ✗ ${entry.error}${entry.screen ? ` — on screen: “${entry.screen.slice(0, 120)}”` : ""}`);
        if (entry.url) log(`       url: ${entry.url}`);
        if (shot) log(`       picture of the failure: ${path.relative(process.cwd(), shot)}`);
        entry.end = sec(Date.now() - t0);
        timeline.push(entry);
        if (m.onFail === "stop") {
          // The camera stops here. One interaction and ten minutes of nothing
          // is the worst thing a demo tool can hand someone.
          partial = `stopped at step ${i} (${entry.summary}) — ${entry.error}`;
          log(`■ ${partial}`);
          break;
        }
        continue;
      }
      entry.end = sec(Date.now() - t0);
      timeline.push(entry);
      if ((Date.now() - t0) / 1000 > capSeconds) {
        ok = false;
        partial = `stopped: the take passed ${capSeconds}s (the maxSeconds cap) at step ${i} of ${m.steps.length} — if the demo is meant to be this long, set maxSeconds in the manifest; if not, something is stuck`;
        log(`■ ${partial}`);
        break;
      }
    }
    endMs = Date.now();

    // testreel: close context, save video, composite cursor/zoom/chrome, mp4.
    // Its ffmpeg pass prints multi-kilobyte expression dumps and, when the
    // cursor expression is too deep, "Error initializing filters" — then
    // carries on and reports success. We listen, trim, and refuse to call
    // that a clean take.
    const compositeLog: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const tap = (orig: typeof origOut) => ((chunk: unknown, ...rest: unknown[]) => {
      const text = String(chunk);
      compositeLog.push(text);
      const trimmed = text.length > 400 ? text.slice(0, 220) + ` … [${text.length - 220} more chars of ffmpeg expression trimmed]\n` : text;
      return (orig as (c: unknown, ...r: unknown[]) => boolean)(trimmed, ...rest);
    }) as typeof origOut;
    process.stdout.write = tap(origOut); process.stderr.write = tap(origErr);
    try {
      const result = await rec.stop();
      video = result.video;
      screenshots = result.screenshots;
      const joined = compositeLog.join("");
      if (/Error initializing filters|Missing '\)' or too many args/.test(joined)) {
        const why = `cursor overlay failed in testreel's ffmpeg pass (~${moves} moves; the filter is too large past ~${CURSOR_MOVE_LIMIT}); the video has NO CURSOR. Split the demo or set cursor: false.`;
        partial = partial ? `${partial}; ${why}` : why;
        ok = false;
        log(`✗ ${why}`);
      }
    } catch (e) {
      partial = `testreel stop() failed: ${(e as Error).message.split("\n")[0]}`;
      log(`✗ ${partial}`);
    } finally {
      process.stdout.write = origOut; process.stderr.write = origErr;
    }
  } catch (e) {
    // A setup failure is not a partial take, it is no take. Let it out.
    if (e instanceof SetupFailed) { await context.close().catch(noop); await browser.close().catch(noop); throw e; }
    ok = false;
    partial = `run aborted: ${(e as Error).message.split("\n")[0]}`;
    log(`✗ ${partial}`);
    if (endMs === t0) endMs = Date.now();
  } finally {
    await context.close().catch(noop);
    await browser.close().catch(noop);
  }

  // Fallback: whatever happened above, if Playwright wrote a .webm we can still
  // ship a plain mp4 (no cursor overlay / chrome) rather than an empty folder.
  if (!video) {
    const webm = fs.readdirSync(rawDir).find((f) => f.endsWith(".webm"));
    if (webm) {
      const dest = path.join(opts.outDir, `${m.name}.mp4`);
      try {
        execFileSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-i", path.join(rawDir, webm), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-an", dest], { stdio: "inherit" });
        video = dest;
        partial = (partial ?? "polished render unavailable") + " — raw video used (no cursor overlay)";
        log(`fallback: ${path.relative(process.cwd(), dest)}`);
      } catch (e) {
        log(`fallback conversion failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  fs.rmSync(rawDir, { recursive: true, force: true });
  if (ownLock) releaseLock(opts.outDir);

  // Timeline offsets are already relative to videoStartedAt (= document commit,
  // calibrated to within ~0.2s of the first video frame on a warm route). The
  // real file length is authoritative for the end.
  if (watchdog) clearInterval(watchdog);
  // The take finished, so there is nothing to resume: leaving the hint would
  // send someone back into the middle of a demo they already have.
  try { fs.rmSync(path.join(opts.outDir, "reached.json"), { force: true }); } catch { /* fine */ }
  const trimBefore = sec(setupEnd - t0);
  // The recording keeps rolling while the browser is torn down, so the raw
  // video always has a tail of nothing after the last step. The take ends
  // where the demo ends (plus a breath), never where the recorder stopped —
  // otherwise every video ships with dead seconds at the end.
  const GRACE = 0.4;
  const videoSec = video ? videoDuration(video) : sec(endMs - t0);
  const last = timeline.at(-1);
  const duration = last && videoSec > last.end + GRACE + 0.1 ? last.end + GRACE : videoSec;
  if (last && duration < videoSec - 0.05) log(`trim: ${(videoSec - duration).toFixed(1)}s of tail after the last step dropped`);
  if (last && videoSec < last.end - 0.5) {
    log(`note: video is ${videoSec.toFixed(1)}s but the last step ended at ${last.end.toFixed(1)}s — check anchoring`);
  }

  const finishedAt = new Date().toISOString();
  const take: Take = {
    video, screenshots, timeline, duration, startedAt, finishedAt, ok, trimBefore, partial, brisk: opts.brisk || undefined,
    quality: { preset: q.name, width: q.viewport.width, height: q.viewport.height, scale: q.scale, fps: q.fps },
    layoutWidth,
    contentWidth,
    pageErrors,
    downloads: ctx.downloads,
    stubbed,
    stubHits: Object.fromEntries(stubHits),
    captureHash: captureHash(m),
    captureSec: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 100) / 10,
  };
  releaseNamed?.();
  fs.writeFileSync(path.join(opts.outDir, "take.json"), JSON.stringify(take, null, 2));
  return take;
}

/** Decide where the camera looks for a scene: explicit focus, else (auto) the
    last selector the demo touched, if it is on screen now. Boxes are video px. */
async function resolveCamera(page: Page, m: Manifest, q: Resolved, step: Extract<Step, { action: "scene" }>, index: number): Promise<TimelineEntry["camera"] | undefined> {
  const policy = step.camera ?? m.camera;
  if (policy === "static") return undefined;
  let focus: string | undefined;
  let zoom = q.cameraZoom;
  if (typeof policy === "object" && !("focus" in policy && policy.focus === undefined && policy.zoom === undefined)) {
    if ("focus" in policy && policy.focus) focus = policy.focus;
    if (policy.zoom) zoom = policy.zoom;
  }
  if (!focus) {
    // auto: walk back to the last step with a selector (a waitFor result beats a click target).
    for (let j = index - 1; j >= 0; j--) {
      const s = m.steps[j];
      if (s.action === "scene") break;
      if ("selector" in s && s.selector && (s.action === "waitFor" || s.action === "click" || s.action === "type" || s.action === "hover")) {
        focus = s.selector;
        break;
      }
    }
  }
  if (!focus) return undefined;
  try {
    const box = await page.locator(focus).first().boundingBox({ timeout: 1500 });
    if (!box || box.width < 4 || box.height < 4) return undefined;
    return { zoom, box, focus };
  } catch {
    return undefined;
  }
}


/** A previous take is not rubbish until a new one exists to replace it — and
 *  even then it might have been the better one.
 *
 * Two separate problems, one mechanism.
 *
 * 1. `run` used to delete the output folder and THEN start the browser, so any
 *    failure in between — a crash, a Ctrl-C, a closed pipe, a dev server
 *    serving the wrong app — left the person with neither the new take nor the
 *    old one. Losing a good recording to a FAILED attempt is the most
 *    expensive thing this tool can do to someone.
 * 2. Even a successful re-record threw the previous take away, and you cannot
 *    tell whether the new one is better until you have watched it.
 *
 * So old artifacts move aside before recording and, on success, become
 * history rather than rubbish.
 *
 * History is deliberately cheap. Measured across 37 real demos: 506 MB total,
 * of which 345 MB is DERIVED — master.mp4, demo.mp4, stills, thumbnails all
 * re-render from take.json plus the raw recording in seconds. So a kept
 * version stores only those two. The largest demo here costs 41 MB a version
 * instead of 139 MB, and stays fully recoverable.
 */
const STASH = ".previous";
const HISTORY = ".history";

/** How many previous takes of a demo to keep, and the ceiling on their total
    size. Small on purpose: this runs on machines whose disks fill up. */
export const KEEP_TAKES = 2;
export const HISTORY_BUDGET_MB = 400;

/** Put back a stash left by a run that died. Call before anything else. */
export function restorePrevious(outDir: string): boolean {
  const stash = path.join(outDir, STASH);
  if (!fs.existsSync(stash)) return false;
  for (const f of fs.readdirSync(stash)) {
    const to = path.join(outDir, f);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(path.join(stash, f), to);
  }
  fs.rmSync(stash, { recursive: true, force: true });
  return true;
}

/** Move the current artifacts aside, keeping the lock and the chosen poster. */
export function stashPrevious(outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  restorePrevious(outDir); // a stash from an earlier crash comes back first
  const keep = new Set([".retake-lock", STASH, HISTORY, ".poster"]);
  const files = fs.readdirSync(outDir).filter((f) => !keep.has(f));
  if (!files.length) return;
  const stash = path.join(outDir, STASH);
  fs.mkdirSync(stash, { recursive: true });
  for (const f of files) fs.renameSync(path.join(outDir, f), path.join(stash, f));
}

export type KeptTake = { id: string; at: string; seconds: number; steps: number; ok: boolean; mb: number; video: string | null };

/** The kept versions of this demo, newest first. */
export function keptTakes(outDir: string): KeptTake[] {
  const root = path.join(outDir, HISTORY);
  if (!fs.existsSync(root)) return [];
  const out: KeptTake[] = [];
  for (const id of fs.readdirSync(root).sort().reverse()) {
    const dir = path.join(root, id);
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, "take.json"), "utf8")) as Take;
      const vid = fs.readdirSync(dir).find((f) => f.endsWith(".webm"));
      let bytes = 0;
      for (const f of fs.readdirSync(dir)) bytes += fs.statSync(path.join(dir, f)).size;
      out.push({
        id, at: t.finishedAt ?? id, seconds: Math.round(t.duration - t.trimBefore),
        steps: t.timeline?.length ?? 0, ok: !!t.ok, mb: Math.round(bytes / 1e5) / 10,
        video: vid ? path.join(dir, vid) : null,
      });
    } catch { /* an unreadable version is not worth keeping */ }
  }
  return out;
}

/** The new take is real. Keep the old one as a version — recording only, since
    everything else re-renders — and prune to the budget. */
export function keepPrevious(outDir: string, log?: (l: string) => void): void {
  const stash = path.join(outDir, STASH);
  if (!fs.existsSync(stash)) return;
  try {
    const takeFile = path.join(stash, "take.json");
    const raw = fs.readdirSync(stash).find((f) => f.endsWith(".webm"));
    const prev = fs.existsSync(takeFile) ? (JSON.parse(fs.readFileSync(takeFile, "utf8")) as Take) : null;
    // A failed take is not worth a version: nobody wants to go back to it.
    if (prev?.ok && raw) {
      const id = (prev.finishedAt ?? new Date().toISOString()).replace(/[:.]/g, "-").slice(0, 19);
      const dir = path.join(outDir, HISTORY, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(takeFile, path.join(dir, "take.json"));
      fs.renameSync(path.join(stash, raw), path.join(dir, raw));
      // take.json points at the raw video by absolute path; keep it findable.
      const moved = JSON.parse(fs.readFileSync(path.join(dir, "take.json"), "utf8")) as Take;
      moved.video = path.join(dir, raw);
      fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify(moved));
      log?.(`kept the previous take as a version (${id})`);
    }
    pruneHistory(outDir, log);
  } catch { /* history is a courtesy; never fail a good take over it */ }
  fs.rmSync(stash, { recursive: true, force: true });
}

/** Keep it small: the newest KEEP_TAKES, and under the size budget. */
export function pruneHistory(outDir: string, log?: (l: string) => void): void {
  let kept = keptTakes(outDir);
  const drop = (k: KeptTake, why: string) => {
    fs.rmSync(path.join(outDir, HISTORY, k.id), { recursive: true, force: true });
    log?.(`dropped version ${k.id} (${why})`);
  };
  for (const k of kept.slice(KEEP_TAKES)) drop(k, `only the last ${KEEP_TAKES} are kept`);
  kept = kept.slice(0, KEEP_TAKES);
  let total = kept.reduce((n, k) => n + k.mb, 0);
  while (kept.length && total > HISTORY_BUDGET_MB) {
    const oldest = kept.pop()!;
    drop(oldest, `history over ${HISTORY_BUDGET_MB} MB`);
    total -= oldest.mb;
  }
}

/** Bring a kept version back as the current take. The caller re-renders. */
export function restoreKept(outDir: string, id: string): boolean {
  const dir = path.join(outDir, HISTORY, id);
  if (!fs.existsSync(path.join(dir, "take.json"))) return false;
  stashPrevious(outDir);
  for (const f of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, f), path.join(outDir, f));
  const tp = path.join(outDir, "take.json");
  const t = JSON.parse(fs.readFileSync(tp, "utf8")) as Take;
  const raw = fs.readdirSync(outDir).find((f) => f.endsWith(".webm"));
  if (raw) { t.video = path.join(outDir, raw); fs.writeFileSync(tp, JSON.stringify(t)); }
  fs.rmSync(path.join(outDir, STASH), { recursive: true, force: true });
  return true;
}

/** One run per output dir at a time — record AND render. Two overlapping runs
    would wipe each other's files and die with ENOENT halfway. Throws if held. */
export function acquireLock(outDir: string): true {
  fs.mkdirSync(outDir, { recursive: true });
  const lock = path.join(outDir, ".retake-lock");
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (pid && pid !== process.pid && isAlive(pid)) throw new Error(`another retake run (pid ${pid}) is using ${path.relative(process.cwd(), outDir)} — wait for it to finish`);
  }
  fs.writeFileSync(lock, String(process.pid));
  return true;
}
export function releaseLock(outDir: string) {
  fs.rmSync(path.join(outDir, ".retake-lock"), { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type StepCtx = {
  outDir: string; manifestDir: string; downloads: string[]; stub: (d: Stub) => Promise<void>;
  /** Replaying to reach a state, with nobody watching: the pacing that exists
      for a viewer is dead weight, so typing runs at full speed and author
      pauses are skipped. Selector waits are NOT touched — those are the ones
      holding the app's actual state together. */
  fast?: boolean;
};

/** testreel clicks and types at *screen* coordinates and never scrolls first,
    so anything below the fold gets a click on empty air. Bring it into view
    ourselves — centred, so the viewer sees the target and the cursor lands on it. */
async function bringIntoView(page: Page, selector: string, timeout: number) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout });
  const box = await loc.boundingBox();
  const vh = page.viewportSize()?.height ?? 800;
  // Off-screen is obvious; the subtler case is a target hugging the bottom
  // edge — visible, but cramped against the caption band and half-cut in
  // the video. Keep a safe zone top and bottom and centre anything inside it.
  const safe = vh * 0.12;
  if (box && (box.y < safe || box.y + box.height > vh - safe)) {
    await loc.evaluate((el) => el.scrollIntoView({ block: "center", behavior: "smooth" }));
    await page.waitForTimeout(450);
  }
}

async function runStep(rec: PageRecorder, page: Page, step: Step, m: Manifest, ctx: StepCtx): Promise<void> {
  const timeout = step.timeout ?? 8000;
  if (step.waitFor) await page.waitForSelector(step.waitFor, { timeout });
  if ((step.action === "click" || step.action === "type" || step.action === "fill" || step.action === "hover") && "selector" in step && step.selector) {
    await bringIntoView(page, step.selector, timeout);
  }
  const q = resolve(m);
  if ((step.action === "click" || step.action === "hover") && step.at) {
    // A point click: the cursor travels there on camera, then the real
    // pointer does the same. For canvases, and for elements whose own
    // handlers make Playwright's actionability checks time out.
    const pt = await resolvePoint(page, step.at, timeout);
    if (q.cursor !== false) await moveCursorToPoint(page, pt.x, pt.y, { style: q.cursor.style, size: q.cursor.size });
    if (step.action === "click") await page.mouse.click(pt.x, pt.y);
    if (step.pauseAfter && !ctx.fast) await page.waitForTimeout(step.pauseAfter);
    return;
  }
  if (step.action === "drag") {
    await performDrag(page, step, q, timeout);
    if (step.pauseAfter && !ctx.fast) await page.waitForTimeout(step.pauseAfter);
    return;
  }
  const pause = ctx.fast ? undefined : step.pauseAfter;
  switch (step.action) {
    case "wait":
      // An author `wait` is pacing for the viewer; while replaying there is
      // none, so it shrinks. Capped rather than dropped: some apps genuinely
      // need a beat, and the state has to arrive intact.
      await rec.wait(ctx.fast ? Math.min(step.ms, 250) : step.ms);
      return; // wait's own duration is the pause
    case "click":
      await rec.click(step.selector!, { timeout, zoom: step.zoom });
      break;
    case "type":
      await rec.type(step.selector, expandEnv(step.text), { delay: ctx.fast ? 0 : (step.delay ?? (m.typing === "brisk" ? 22 : 70)), clear: step.clear, timeout });
      break;
    case "fill":
      await rec.fill(step.selector, expandEnv(step.text), { timeout });
      break;
    case "hover":
      await rec.hover(step.selector!, { timeout });
      break;
    case "select": {
      /* Hover first so the cursor actually travels to the control — a value
         that changes with nothing moving reads as a glitch rather than a
         choice. Playwright takes the option by value or by visible label, and
         a page may use either, so try one and fall back to the other. */
      await rec.hover(step.selector, { timeout });
      const target = page.locator(step.selector).first();
      try {
        await target.selectOption({ value: step.value }, { timeout });
      } catch {
        await target.selectOption({ label: step.value }, { timeout });
      }
      break;
    }
    case "scroll": {
      let dy = step.y;
      if (step.to === "top" || step.to === "bottom") {
        // Absolute: the page's ends. A relative y: 0 is, correctly, no move.
        const want = step.to;
        const cur = await page.evaluate(() => ({ y: window.scrollY, max: document.documentElement.scrollHeight - window.innerHeight }));
        dy = Math.round((want === "top" ? 0 : cur.max) - cur.y);
      } else if (step.to) {
        // Work out how far to move so the element sits where we asked, then let
        // testreel animate that distance (an eased scroll, not a jump).
        const box = await page.locator(step.to).first().boundingBox({ timeout });
        if (box) {
          const vh = page.viewportSize()?.height ?? 800;
          const want = step.align === "top" ? 80 : step.align === "bottom" ? vh - box.height - 80 : (vh - box.height) / 2;
          dy = Math.round(box.y - want);
        }
      }
      // A viewer's eye wants roughly constant pixels per second, not a fixed
      // 600ms per scroll: unset, speed derives from distance (~1100 px/s,
      // never faster than 0.4s, never slower than 2.5s).
      const dist = Math.abs(dy ?? 0) + Math.abs(step.x ?? 0);
      const autoMs = Math.min(2500, Math.max(400, (dist / 1100) * 1000));
      const scrollSpeed = step.speed ?? (dist ? 600 / autoMs : 1);
      if (dy || step.x) await rec.scroll({ x: step.x, y: dy, scrollSpeed });
      break;
    }
    case "zoom":
      await rec.zoom({ selector: step.selector, scale: step.scale, x: step.x, y: step.y, duration: step.duration });
      break;
    case "keyboard":
      await rec.keyboard(step.key);
      break;
    case "navigate":
      await rec.navigate(expandEnv(step.url));
      break;
    case "screenshot":
      await rec.screenshot(step.name);
      break;
    case "upload": {
      const files = (Array.isArray(step.files) ? step.files : [step.files]).map((f) => path.resolve(ctx.manifestDir, expandEnv(f)));
      for (const f of files) if (!fs.existsSync(f)) throw new Error(`upload: no such file ${f}`);
      await page.setInputFiles(step.selector, files, { timeout });
      break;
    }
    case "download": {
      const dir = path.join(ctx.outDir, "downloads");
      fs.mkdirSync(dir, { recursive: true });
      const [dl] = await Promise.all([
        page.waitForEvent("download", { timeout: step.timeout ?? 30_000 }),
        step.selector ? rec.click(step.selector, { timeout }) : Promise.resolve(),
      ]);
      const name = step.saveAs ?? dl.suggestedFilename();
      if (step.expect && !dl.suggestedFilename().includes(step.expect)) throw new Error(`download: expected a name containing "${step.expect}", got "${dl.suggestedFilename()}"`);
      const dest = path.join(dir, name);
      await dl.saveAs(dest);
      ctx.downloads.push(dest);
      break;
    }
    case "select": {
      // The cursor travels to it on camera (testreel has no select of its
      // own), then the option is chosen by value, falling back to its
      // visible label — a manifest author should not have to know which
      // one the page uses.
      await rec.hover(step.selector, { timeout });
      const sel = page.locator(step.selector).first();
      try { await sel.selectOption(step.value, { timeout }); }
      catch { await sel.selectOption({ label: step.value }, { timeout }); }
      break;
    }
    case "waitFor":
      // Shared with `dry`, so the cheap check waits for the same conditions
      // the recorder does — see waiting.ts for what used to happen instead.
      await waitForStep(page, step);
      break;
    case "evaluate":
      await page.evaluate(step.script);
      break;
    case "stub":
      await ctx.stub({ url: step.url, method: step.method, status: step.status ?? 200, json: step.json, from: step.from, contentType: "application/json; charset=utf-8" });
      break;
    case "callout":
      // The box was resolved in the caller; on camera this is a hold while
      // the (render-time) ring has the viewer's eye.
      await page.waitForTimeout(step.ms / m.speed);
      break;
    case "scene":
      // A marker only. Its timestamp is the point of the step.
      break;
    default: {
      const never: never = step;
      throw new Error(`unknown step ${JSON.stringify(never)}`);
    }
  }
  if (pause) await page.waitForTimeout(pause / m.speed);
}

const pointName = (p: Point | undefined): string =>
  p === undefined ? "?" : typeof p === "string" ? p : "x" in p ? `(${Math.round(p.x)},${Math.round(p.y)})` : `${p.selector}+(${p.dx},${p.dy})`;

export function describe(step: Step): string {
  switch (step.action) {
    case "wait":
      return `wait ${step.ms}ms`;
    case "click":
      return `click ${step.selector ?? pointName(step.at)}${step.zoom ? ` (zoom ${step.zoom}x)` : ""}`;
    case "drag":
      return `drag ${pointName(step.from)} → ${pointName(step.to)}`;
    case "type":
      if (step.secret) return `type •••••• → ${step.selector}`;
      return `type "${step.text.length > 48 ? step.text.slice(0, 45) + "…" : step.text}" → ${step.selector}`;
    case "fill":
      return `fill ${step.selector}${step.secret ? " ••••••" : ""}`;
    case "hover":
      return `hover ${step.selector ?? pointName(step.at)}`;
    case "select":
      return `select "${step.value}" in ${step.selector}`;
    case "scroll":
      return step.to ? `scroll to ${step.to} (${step.align})` : `scroll x=${step.x ?? 0} y=${step.y ?? 0}`;
    case "zoom":
      return `zoom ${step.scale}x ${step.selector ?? ""}`.trim();
    case "keyboard":
      return `key ${step.key}`;
    case "navigate":
      return `go ${step.url}`;
    case "screenshot":
      return `screenshot ${step.name ?? ""}`.trim();
    case "upload":
      return `upload ${(Array.isArray(step.files) ? step.files : [step.files]).map((f) => path.basename(f)).join(", ")} → ${step.selector}`;
    case "download":
      return `download${step.selector ? ` via ${step.selector}` : ""}${step.saveAs ? ` → ${step.saveAs}` : ""}`;
    case "waitFor":
      return describeWait(step);
    case "evaluate":
      return `evaluate (${step.script.length} chars)`;
    case "stub":
      return `stub ${step.method ? step.method + " " : ""}${step.url}`;
    case "callout":
      return `callout ${step.selector ?? pointName(step.at)}${step.label ? ` “${step.label}”` : ""}`;
    case "scene":
      return `scene: ${step.label}`;
  }
}

/** Wall-clock ms when the recorded page's document committed — empirically
    where Playwright's first video frame lands (falls back to now). */
async function firstPaintWallClock(page: Page): Promise<number> {
  try {
    const t = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return nav ? performance.timeOrigin + nav.responseStart : null;
    });
    if (t) return Math.round(t);
  } catch {
    /* fall through */
  }
  return Date.now();
}

// --- seeding -------------------------------------------------------------

/** "-12d" → twelve days ago, "+6h" → six hours from now, "now" → now; all
    as epoch ms. Anything else passes through untouched. */
export function resolveRelativeDates<T>(value: T, now = Date.now()): T {
  const UNIT: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v === "now") return now;
      const m = /^([+-])(\d+(?:\.\d+)?)([mhdw])$/.exec(v);
      if (m) return now + (m[1] === "-" ? -1 : 1) * Number(m[2]) * UNIT[m[3]];
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export async function runFileOrCommandSeed(s: Seed, dir: string, log: (l: string) => void) {
  if (s.kind === "file") {
    const src = path.resolve(dir, s.from);
    const dest = path.resolve(dir, expandEnv(s.path));
    let body = fs.readFileSync(src, "utf8");
    const parsed = JSON.parse(body); // fail loudly on a broken seed
    if (s.relativeDates) body = JSON.stringify(resolveRelativeDates(parsed));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, body);
    log(`seed: wrote ${path.relative(process.cwd(), dest)}${s.relativeDates ? " (relative dates resolved)" : ""}`);
  } else if (s.kind === "command") {
    log(`seed: $ ${s.run}`);
    await runSeedCommand(expandEnv(s.run), s.run, dir);
  }
}

/** Anything that asks to outlive the command that started it. A seed's job is
    to put data in place and exit; starting a server is `start_app`'s job, and
    that one is gated on the person's say-so. Backgrounding here would walk
    straight around that gate, so it is refused by name. */
const BACKGROUNDING: [RegExp, string][] = [
  // A lone `&` is backgrounding; `&&` is just "and then". Quoted spans are
  // stripped before this runs, so a URL's query string is not mistaken for it.
  [/(?<!&)&(?!&)/, "a bare `&`"],
  [/\bnohup\b/, "nohup"],
  [/\bdisown\b/, "disown"],
  [/\b(?:screen|tmux)\s+(?:-\w+\s+)*(?:new|new-session|start)/, "screen/tmux"],
  [/\bpm2\s+(?:start|restart)\b/, "pm2"],
  [/\bforever\s+start\b/, "forever"],
];

/** A seed command runs to completion or it does not run. */
export const SEED_TIMEOUT_MS = 120_000;

export async function runSeedCommand(cmd: string, shown: string, dir: string, timeoutMs = SEED_TIMEOUT_MS): Promise<void> {
  // Quoted arguments are data, not shell syntax: a URL's `?a=1&b=2` is not an
  // attempt to background anything.
  const bare = cmd.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  for (const [re, what] of BACKGROUNDING) {
    if (re.test(bare)) {
      throw new Error(
        `Refusing to run this seed command because it uses ${what}, which leaves a process running after the seed finishes:\n  ${shown}\n\n` +
        `A seed puts data in place and exits. To start the app itself, use Retake's start_app — starting processes is something the person allows explicitly, and a seed must not become the way around that.`,
      );
    }
  }
  // `detached` puts the shell in its own process group so a timeout can kill
  // what it spawned as well. spawnSync cannot do this, which is why the seed
  // path is async: killing only the shell would orphan the very process this
  // timeout exists to stop.
  const child = spawn(cmd, [], { shell: true, stdio: "inherit", cwd: dir, detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }, timeoutMs);
  const status = await new Promise<number | null>((done, fail) => {
    child.once("error", (e) => { clearTimeout(timer); fail(e); });
    child.once("close", (code) => { clearTimeout(timer); done(code); });
  });
  if (timedOut) {
    throw new Error(
      `Seed command did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped:\n  ${shown}\n\n` +
      `If it is meant to start the app rather than seed it, use start_app instead — a seed has to exit before the take can begin.`,
    );
  }
  if (status !== 0) throw new Error(`Seed command failed (exit ${status}):\n  ${shown}`);
}

export async function runEvaluateSeed(page: Page, s: Extract<Seed, { kind: "evaluate" }>, dir: string, log: (l: string) => void) {
  const data = s.from ? JSON.parse(fs.readFileSync(path.resolve(dir, s.from), "utf8")) : undefined;
  log(`seed: evaluate${s.from ? ` (${s.from})` : ""}`);
  await page.evaluate(
    async ({ script, data }) => {
      (window as unknown as { __seed: unknown }).__seed = data;
      // eslint-disable-next-line no-new-func
      await new Function(`return (async () => { ${script} })()`)();
    },
    { script: s.script, data },
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => { /* busy sites never idle; the selector gate decides */ });
}
