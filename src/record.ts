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
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { chromium, type Page } from "playwright";
import { recordPage, type PageRecorder } from "testreel";
import { expandEnv, resolve, type Manifest, type Resolved, type Seed, type Step, type Stub } from "./manifest.js";
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
  /** Where the camera looks (video-pixel box) and how far in. */
  camera?: { zoom: number; box: { x: number; y: number; width: number; height: number }; focus: string };
};

export type Take = {
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
  /** The resolved preset the take was recorded with (render reads it). */
  quality: { preset: string; width: number; height: number; scale: number; fps: number };
  /** Hash of everything that shapes the recording — same hash → the raw take can be reused. */
  captureHash?: string;
  /** Wall-clock seconds the recording took (browser open → closed). */
  captureSec?: number;
  /** Files the run downloaded, saved under outputs/<name>/downloads/. */
  downloads?: string[];
  /** Endpoints answered with canned data during this take. Named in the proof
      log so a stubbed demo can never quietly pass as a live one. */
  stubbed?: string[];
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

export type RecordOptions = {
  outDir: string;
  /** The caller already holds the folder lock. */
  locked?: boolean;
  headed?: boolean;
  skipSeed?: boolean;
  manifestDir: string;
  log?: (line: string) => void;
};

const noop = () => {};

export async function record(m: Manifest, opts: RecordOptions): Promise<Take> {
  const log = opts.log ?? noop;
  const startedAt = new Date().toISOString();
  fs.mkdirSync(opts.outDir, { recursive: true });

  // The caller (cli run) holds the folder lock across record + render; if it
  // did not, take it here for the recording at least.
  const ownLock = !opts.locked && acquireLock(opts.outDir);

  // Playwright writes its in-progress .webm to a private per-run dir, never to
  // the shared output dir, so nothing else can delete it mid-take.
  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), `retake-${m.name}-`));
  const q = resolve(m);
  log(`preset ${q.name} · canvas ${q.width}×${q.height} · viewport ${q.viewport.width}×${q.viewport.height} @ ${q.fps}fps · page scale ${q.scale}×`);

  if (!opts.skipSeed) {
    for (const s of m.seed) await runFileOrCommandSeed(s, opts.manifestDir, log);
  }

  const browser = await chromium.launch({ headless: !opts.headed });
  const size = { ...q.viewport };
  // A saved session (auth.storageState) means the login already happened on an
  // earlier run: load it and the setup login steps can be skipped.
  const statePath = m.auth ? path.resolve(opts.manifestDir, expandEnv(m.auth.storageState)) : null;
  const stateFresh = !!statePath && fs.existsSync(statePath) && (Date.now() - fs.statSync(statePath).mtimeMs) / 3.6e6 < (m.auth?.maxAgeHours ?? 72);
  if (statePath) log(stateFresh ? `auth: reusing session ${path.relative(process.cwd(), statePath)}` : `auth: no fresh session — running setup to sign in`);
  const context = await browser.newContext({
    viewport: size,
    colorScheme: m.colorScheme,
    ...(m.reducedMotion ? { reducedMotion: "reduce" as const } : {}),
    recordVideo: { dir: rawDir, size },
    ...(stateFresh && statePath ? { storageState: statePath } : {}),
  });
  // The page lays out at `scale`× (CSS zoom): the app sees a smaller viewport
  // and renders crisp into the full canvas. Coordinates testreel/Playwright
  // see are already video pixels, so cursor and clicks line up.
  // Scale via a <style> tag, not an inline attribute: React hydration diffs
  // element attributes against the server HTML, so style.zoom on <html> made
  // every React app report a hydration mismatch — with a dev badge in shot.
  if (q.scale !== 1) await context.addInitScript(`document.addEventListener("DOMContentLoaded",()=>{const st=document.createElement("style");st.textContent="html{zoom:${q.scale}}";document.head.appendChild(st)})`);
  // Dev servers decorate themselves — Next's issues badge, Vite's error
  // overlay, webpack's. None of that belongs in a product video, and no
  // manifest should have to know about it.
  await context.addInitScript(`document.addEventListener("DOMContentLoaded",()=>{const st=document.createElement("style");st.textContent="nextjs-portal,#__next-build-watcher,vite-error-overlay,#webpack-dev-server-client-overlay,#react-refresh-overlay{display:none!important}";document.head.appendChild(st)})`);

  // Canned responses live in a map the route handler reads on every request, so
  // a `stub` step mid-demo swaps the answer without re-registering anything.
  // Keyed by method+url: a POST stub must not replace the GET stub on the same
  // path — they are different answers to different questions.
  const stubs = new Map<string, Stub>();
  const stubbed: string[] = [];
  const armStub = async (d: Stub) => {
    const key = `${d.method ?? "ANY"} ${d.url}`;
    const fresh = !stubs.has(key);
    stubs.set(key, d);
    if (!stubbed.includes(key)) stubbed.push(key);
    if (!fresh) return;
    await context.route(d.url, async (route, request) => {
      const cur = stubs.get(key)!;
      if (cur.method && request.method().toUpperCase() !== cur.method.toUpperCase()) return route.fallback();
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
  let video: string | undefined;
  let screenshots: string[] = [];
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

    // --- setup phase (still inside the video; trimmed later by `trimBefore`) ---
    await page.goto(expandEnv(m.url), { waitUntil: "networkidle" });
    if (!opts.skipSeed) {
      for (const s of m.seed) {
        if (s.kind === "evaluate") await runEvaluateSeed(page, s, opts.manifestDir, log);
      }
    }
    if (m.waitForSelector) await page.waitForSelector(m.waitForSelector, { timeout: 20_000 });

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
    const LONG = 60;
    const cursorIdleHide = q.cursor === false ? undefined : q.cursor.idleHide ?? (m.steps.length <= LONG);
    if (q.cursor !== false && q.cursor.idleHide === undefined && m.steps.length > LONG) log(`cursor: ${m.steps.length} steps — idle-hide fades off (ffmpeg nesting limit); set cursor.idleHide to override`);
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
        log(`setup step failed: ${describe(step.st)} — ${(e as Error).message}`);
      }
    }
    // Persist the signed-in session so later takes skip the login entirely —
    // but never a broken one: saving after a failed login poisons every later
    // run, which then "reuses" a logged-out session and records the login
    // page while believing it is signed in.
    if (statePath && !stateFresh && authOk) {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      await context.storageState({ path: statePath });
      log(`auth: saved session → ${path.relative(process.cwd(), statePath)}`);
    } else if (statePath && !stateFresh) {
      log("auth: a sign-in step failed — NOT saving this session");
    }
    setupEnd = Date.now();

    // The cap scales with the demo unless the manifest says otherwise: a
    // 170-step walkthrough is long, not stuck.
    const explicitWaits = m.steps.reduce((n, st) => n + (st.action === "wait" ? st.ms / 1000 : 0) + ((st as { pauseAfter?: number }).pauseAfter ?? 0) / 1000, 0);
    const capSeconds = m.maxSeconds ?? Math.min(3600, Math.max(240, Math.round(m.steps.length * 10 + explicitWaits)));
    for (const [i, step] of m.steps.entries()) {
      const start = Date.now();
      const entry: TimelineEntry = {
        index: i,
        action: step.action,
        summary: describe(step),
        start: sec(start - t0),
        end: 0,
        ok: true,
      };
      if (step.action === "scene") {
        entry.label = step.label;
        entry.caption = step.caption;
        entry.holdMs = step.holdMs;
        entry.camera = await resolveCamera(page, m, q, step, i);
      }
      log(`[${String(i).padStart(2, "0")}] ${entry.summary}${entry.camera ? ` · camera ${entry.camera.zoom}× on ${entry.camera.focus}` : ""}`);
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
        log(`     ✗ ${entry.error}${entry.screen ? ` — on screen: “${entry.screen.slice(0, 120)}”` : ""}`);
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
    try {
      const result = await rec.stop();
      video = result.video;
      screenshots = result.screenshots;
    } catch (e) {
      partial = `testreel stop() failed: ${(e as Error).message.split("\n")[0]}`;
      log(`✗ ${partial}`);
    }
  } catch (e) {
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
  const trimBefore = sec(setupEnd - t0);
  const duration = video ? videoDuration(video) : sec(endMs - t0);
  const last = timeline.at(-1);
  if (last && Math.abs(duration - last.end) > 3) {
    log(`note: video is ${duration.toFixed(1)}s but the last step ended at ${last.end.toFixed(1)}s — check anchoring`);
  }

  const finishedAt = new Date().toISOString();
  const take: Take = {
    video, screenshots, timeline, duration, startedAt, finishedAt, ok, trimBefore, partial,
    quality: { preset: q.name, width: q.viewport.width, height: q.viewport.height, scale: q.scale, fps: q.fps },
    downloads: ctx.downloads,
    stubbed,
    captureHash: captureHash(m),
    captureSec: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 100) / 10,
  };
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

type StepCtx = { outDir: string; manifestDir: string; downloads: string[]; stub: (d: Stub) => Promise<void> };

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
  if ((step.action === "click" || step.action === "type" || step.action === "fill" || step.action === "hover") && "selector" in step) {
    await bringIntoView(page, step.selector, timeout);
  }
  const pause = step.pauseAfter;
  switch (step.action) {
    case "wait":
      await rec.wait(step.ms);
      return; // wait's own duration is the pause
    case "click":
      await rec.click(step.selector, { timeout, zoom: step.zoom });
      break;
    case "type":
      await rec.type(step.selector, expandEnv(step.text), { delay: step.delay ?? 70, clear: step.clear, timeout });
      break;
    case "fill":
      await rec.fill(step.selector, expandEnv(step.text), { timeout });
      break;
    case "hover":
      await rec.hover(step.selector, { timeout });
      break;
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
      if (dy || step.x) await rec.scroll({ x: step.x, y: dy, scrollSpeed: step.speed });
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
    case "waitFor":
      await page.waitForSelector(step.selector, { timeout: step.timeout ?? 30_000 });
      break;
    case "evaluate":
      await page.evaluate(step.script);
      break;
    case "stub":
      await ctx.stub({ url: step.url, method: step.method, status: step.status ?? 200, json: step.json, from: step.from, contentType: "application/json; charset=utf-8" });
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

export function describe(step: Step): string {
  switch (step.action) {
    case "wait":
      return `wait ${step.ms}ms`;
    case "click":
      return `click ${step.selector}${step.zoom ? ` (zoom ${step.zoom}x)` : ""}`;
    case "type":
      if (step.secret) return `type •••••• → ${step.selector}`;
      return `type "${step.text.length > 48 ? step.text.slice(0, 45) + "…" : step.text}" → ${step.selector}`;
    case "fill":
      return `fill ${step.selector}${step.secret ? " ••••••" : ""}`;
    case "hover":
      return `hover ${step.selector}`;
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
      return `wait for ${step.selector}`;
    case "evaluate":
      return `evaluate (${step.script.length} chars)`;
    case "stub":
      return `stub ${step.method ? step.method + " " : ""}${step.url}`;
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
    execSync(expandEnv(s.run), { stdio: "inherit", cwd: dir });
  }
}

async function runEvaluateSeed(page: Page, s: Extract<Seed, { kind: "evaluate" }>, dir: string, log: (l: string) => void) {
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
  await page.reload({ waitUntil: "networkidle" });
}
