/** `run` for Mac apps: the same Take the browser recorder returns, so render,
    captions, presets, checks, the proof log and share pages need no change.

    The camera is Retake's own window recorder (one window, Retina, nothing
    else on screen); the hands are cua-driver, acting on exact controls. The
    pointer is not in the recording, so Retake draws a Mac arrow onto it from
    the click points, gliding to each click as a person's hand would. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, type Manifest } from "../manifest.js";
import type { RecordOptions, Take, TimelineEntry } from "../record.js";
import { ffmpegBin, videoDuration } from "../media-bin.js";
import { NATIVE_TAKE } from "../paths.js";
import { CuaSession } from "./cua.js";
import { recordWindow } from "./capture.js";
import { requireReady } from "./native-doctor.js";
import { openApp, perform, snapshot, type Ctx } from "./native.js";

const CURSOR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "cursor-arrow.png");
/** Where the arrow's tip sits in the image (2,2 pt, drawn at 2x). */
const HOT = { x: 4, y: 4 };
const GLIDE = 0.6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sec = (x: number) => Math.round(x * 1000) / 1000;

export type Click = { t: number; x: number; y: number };

/** The arrow's position over time as two ffmpeg expressions: still until
    GLIDE seconds before each click, then an eased glide onto it. Built flat
    (a sum of windows) rather than nested: ffmpeg stops at 98 nesting levels. */
export function cursorPath(clicks: Click[], start: { x: number; y: number }): { x: string; y: string; from: number } {
  const pts = [{ t: Math.max(0, (clicks[0]?.t ?? 0) - GLIDE), ...start }, ...clicks];
  const axis = (k: "x" | "y") => {
    const parts: string[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const g0 = Math.max(a.t, b.t - GLIDE), g1 = b.t;
      const u = `clip((t-${g0.toFixed(3)})/${Math.max(0.001, g1 - g0).toFixed(3)},0,1)`;
      // This stretch owns [a.t, b.t): it rests at a, then eases onto b, and
      // ends exactly where the next one begins, so no moment is counted twice.
      parts.push(`gte(t,${a.t.toFixed(3)})*lt(t,${b.t.toFixed(3)})*(${a[k]}+(${b[k] - a[k]})*(3*pow(${u},2)-2*pow(${u},3)))`);
    }
    const last = pts[pts.length - 1];
    parts.push(`gte(t,${last.t.toFixed(3)})*${last[k]}`);
    return `(${parts.join("+")})-${HOT[k]}`;
  };
  return { x: axis("x"), y: axis("y"), from: pts[0].t };
}

/** What the recorder borrows from record.ts, handed in rather than imported:
    record.ts loads this file, so importing it back would be a loop. */
export type RecorderParts = {
  describe: (st: Manifest["steps"][number]) => string;
  captureHash: (m: Manifest, dir?: string) => string;
  runFileOrCommandSeed: (sd: Manifest["seed"][number], dir: string, log: (l: string) => void) => Promise<void>;
};

export async function recordNative(m: Manifest, opts: RecordOptions, { describe, captureHash, runFileOrCommandSeed }: RecorderParts): Promise<Take> {
  requireReady();
  const log = opts.log ?? (() => {});
  const q = resolve(m);
  const dir = opts.manifestDir ?? process.cwd();
  fs.mkdirSync(opts.outDir, { recursive: true });
  if (!opts.skipSeed) for (const sd of m.seed) await runFileOrCommandSeed(sd, dir, log);
  const s = await CuaSession.open();
  const raw = path.join(opts.outDir, "native-raw.mp4");
  const timeline: TimelineEntry[] = [];
  const clicks: Click[] = [];
  let ok = true, setupEnd = 0, t0 = 0, startedAt = "";
  let win: Ctx["win"];
  try {
    const w = await openApp(s, m, log);
    const ctx: Ctx = { s, w, dry: false };
    // The first read of an app's controls is the slow one (~7 s in TextEdit,
    // ~1 s after): pay it before the camera rolls, not in the video.
    const warm = await snapshot(s, w, { shot: true });
    ctx.shotScale = warm.shot.width / warm.window.width;
    ctx.win = warm.window;
    const rec = recordWindow(w.windowId, raw, q.fps);
    try {
      const started = await rec.started;
      t0 = started.at;
      startedAt = new Date(t0).toISOString();
      log(`recording ${m.app} · ${started.width}×${started.height} · only its window is in the video`);
      await sleep(400);
      for (const st of m.setup) await perform(ctx, st);
      setupEnd = Date.now();
      for (const [i, st] of m.steps.entries()) {
        const start = (Date.now() - t0) / 1000;
        const entry: TimelineEntry = { index: i, action: st.action, summary: describe(st), start: sec(start), end: sec(start), ok: true };
        if (st.action === "scene") Object.assign(entry, { label: st.label, caption: st.caption, holdMs: st.holdMs });
        try {
          await perform(ctx, st);
          if (st.action === "click" && ctx.last?.frame && ctx.win) {
            win = ctx.win;
            clicks.push({ t: entry.start, x: Math.round((ctx.last.frame.x + ctx.last.frame.w / 2 - ctx.win.x) * w.scale), y: Math.round((ctx.last.frame.y + ctx.last.frame.h / 2 - ctx.win.y) * w.scale) });
          }
          if (st.pauseAfter) await sleep(st.pauseAfter);
        } catch (e) {
          ok = false;
          entry.ok = false;
          entry.error = (e as Error).message.split("\n")[0];
          log(`✗ step ${i} ${entry.summary} — ${entry.error}`);
        }
        entry.end = sec((Date.now() - t0) / 1000);
        timeline.push(entry);
        if (!entry.ok && m.onFail !== "continue") break;
      }
      await sleep(800);
    } finally {
      await rec.stop().catch((e) => log(`recorder: ${(e as Error).message}`));
    }
  } finally { await s.close(); }
  if (!fs.existsSync(raw)) throw new Error("the window recorder wrote no video");

  // The pointer: a Mac arrow drawn on from the click points.
  let video = raw, partial: string | undefined;
  const out = path.join(opts.outDir, NATIVE_TAKE);
  if (clicks.length) {
    const p = cursorPath(clicks, { x: Math.round(q.viewport.width / 2), y: Math.round(q.viewport.height / 2) });
    const r = spawnSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-i", raw, "-i", CURSOR, "-filter_complex",
      `[0:v][1:v]overlay=x='${p.x}':y='${p.y}':enable='gte(t,${p.from.toFixed(3)})':eval=frame,format=yuv420p`, "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-an", out], { encoding: "utf8" });
    if (r.status === 0) { video = out; fs.rmSync(raw, { force: true }); }
    else partial = `the pointer could not be drawn on (${(r.stderr || "ffmpeg failed").trim().split("\n").pop()}); the video has no cursor`;
  } else { fs.renameSync(raw, out); video = out; }
  void win;

  const videoSec = videoDuration(video);
  const last = timeline.at(-1);
  const duration = last && videoSec > last.end + 0.5 ? last.end + 0.4 : videoSec;
  const finishedAt = new Date().toISOString();
  const take: Take = {
    video, screenshots: [], timeline, duration, startedAt, finishedAt, ok, trimBefore: m.setup.length ? sec((setupEnd - t0) / 1000) : 0, partial,
    quality: { preset: q.name, width: q.viewport.width, height: q.viewport.height, scale: 1, fps: q.fps },
    captureHash: captureHash(m, dir),
    captureSec: Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 100) / 10,
  };
  fs.writeFileSync(path.join(opts.outDir, "take.json"), JSON.stringify(take, null, 2));
  return take;
}
