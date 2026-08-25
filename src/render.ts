/**
 * Render: the raw take → the artifacts you actually ship.
 *
 *   master.mp4      one clean H.264 encode (CRF 14) of the composed video — keep this
 *   demo.mp4        the shareable, at the preset's CRF
 *   demo.gif        gifski if installed (much better), else ffmpeg palette — secondary
 *   thumbnail.png   the frame at a chosen scene
 *   proof-log.md    what ran, when, whether it worked, the shot list, and the quality facts
 *
 * Composition happens once, in ffmpeg, from the take's timeline:
 *   fps → camera (zoompan toward each scene's focus box) → layout (band / card / overlay) → captions
 * The card frame (rounded corners, shadow, soft background) is a PNG rendered
 * by a headless page, overlaid with a transparent hole where the video shows.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { capSecondsFor, restorePrevious } from "./record.js";
import { bandHeightFor, maxCharsFor, wrap } from "./captions.js";
import { renderCard, renderCalloutOverlay, renderTitledCover } from "./cards.js";
import { describeIdle, planIdle, warpFilterArgs, warpTake } from "./pace.js";
import { DEFAULT_VOICE, audioSeconds, synthesize } from "./voice.js";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { expandEnv, resolve, type Manifest, type Resolved, type Step } from "./manifest.js";
import type { Take, TimelineEntry } from "./record.js";

export type Artifacts = {
  master?: string;
  mp4?: string;
  gif?: string;
  thumbnail?: string;
  proofLog: string;
  facts?: Facts;
};

export type Facts = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  sizes: Record<string, number>;
  gifTool: "gifski" | "ffmpeg" | "none";
  layout: string;
  cameraScenes: number;
  encoder: string;
  /** Seconds per stage. */
  timings: Record<string, number>;
  renderHash: string;
  /** demo or launch — so an output says what it was made to be. */
  mode?: "demo" | "launch";
  preset: string;
  cached?: boolean;
};

export type RenderOptions = {
  log?: (l: string) => void;
  /** Re-render even if the render hash matches the last one. */
  force?: boolean;
  /** Render only this scene (label) to scene-<label>.mp4, fast, no other artifacts. */
  scene?: string;
};

/** What the render depends on: the raw take + everything in the manifest that
    shapes the picture. Same hash → same output → skip. */
export function renderHash(m: Manifest, take: Take): string {
  const q = resolve(m);
  const src = take.video && fs.existsSync(take.video) ? fs.statSync(take.video) : null;
  const h = createHash("sha1");
  const merged = applyManifest(m, take);
  h.update(JSON.stringify({ q, tempo: m.tempo, cap: m.captions, theme: m.theme, camera: m.camera, cards: [m.intro, m.outro], idle: m.compressIdle, vo: m.voiceover, music: m.music ? [m.music, (() => { try { const f = typeof m.music === "string" ? m.music : m.music.file; const st = fs.statSync(path.resolve(f)); return [st.size, Math.round(st.mtimeMs)]; } catch { return null; } })()] : null, gif: m.outputs.gif, thumb: m.outputs.thumbnail, stills: m.outputs.stills, video: src ? [src.size, Math.round(src.mtimeMs)] : null, tl: merged.timeline.map((t) => [t.start, t.end, t.label, t.caption, t.holdMs, t.camera, t.callout]), trim: [merged.trimBefore, merged.duration] }));
  return h.digest("hex").slice(0, 12);
}

const require = createRequire(import.meta.url);

let cachedBin: string | undefined;
/** The static build first: Homebrew's ffmpeg is often built without freetype (no drawtext). */
export function ffmpegBin(): string {
  if (cachedBin) return cachedBin;
  try {
    const p = require("ffmpeg-static") as string;
    if (p && fs.existsSync(p)) return (cachedBin = p);
  } catch {
    /* fall through */
  }
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return (cachedBin = "ffmpeg");
}

export function gifskiBin(): string | null {
  for (const p of ["/opt/homebrew/bin/gifski", "/usr/local/bin/gifski"]) if (fs.existsSync(p)) return p;
  try {
    execFileSync("gifski", ["--version"], { stdio: "ignore" });
    return "gifski";
  } catch {
    return null;
  }
}

function ff(args: string[], log?: (l: string) => void) {
  log?.(`$ ffmpeg ${args.join(" ")}`);
  execFileSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}

/** ffmpeg -i probe: duration and stream size, no ffprobe needed. */
export function probe(file: string): { duration: number; width: number; height: number; fps: number } {
  const out = String(spawnSync(ffmpegBin(), ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr);
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  const v = /Video:.*?\s(\d{2,5})x(\d{2,5})[\s,].*?(\d+(?:\.\d+)?)\s*fps/.exec(out) ?? /Video:.*?\s(\d{2,5})x(\d{2,5})/.exec(out);
  if (!d) throw new Error(`could not read duration of ${file}`);
  return {
    duration: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
    fps: v && v[3] ? Number(v[3]) : 0,
  };
}
export const videoDuration = (file: string) => probe(file).duration;

/** ffmpeg drawtext needs a few characters escaped inside the filter graph. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/%/g, "\\%").replace(/,/g, "\\,");
}

const DEFAULT_FONTS = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

/** The take as the *current* manifest describes it: captions, holds, camera
    zooms and trim can all be changed after the fact and re-rendered, because
    none of them need the browser again. Scenes are matched by label. */
export function applyManifest(m: Manifest, take: Take): Take {
  const bySceneLabel = new Map<string, Extract<Step, { action: "scene" }>>();
  for (const st of m.steps) if (st.action === "scene") bySceneLabel.set(st.label, st);
  const timeline = take.timeline.map((e) => {
    if (e.action !== "scene" || !e.label) return e;
    const st = bySceneLabel.get(e.label);
    if (!st) return e;
    const out: TimelineEntry = { ...e, caption: st.caption, holdMs: st.holdMs };
    const cam = st.camera;
    if (cam === "static") out.camera = undefined;
    else if (cam && typeof cam === "object" && cam.zoom && e.camera) out.camera = { ...e.camera, zoom: cam.zoom };
    return out;
  });
  const head = m.trim.head ?? 0;
  const tail = m.trim.tail ?? 0;
  const trimBefore = take.trimBefore + head;
  const duration = Math.max(trimBefore + 1, take.duration - tail);
  return { ...take, timeline, trimBefore, duration };
}


/** Apply the manifest's render-time scene nudges to a take.
 *
 * Scene markers come out of the recording, so getting one in the wrong place
 * used to mean recording the whole thing again — with a live model in the
 * middle of it, at 2.3x the video's length. A nudge moves the marker instead,
 * and everything downstream (captions, stills, the thumbnail) reads scene
 * times through here, so all of it moves together for the price of a render.
 *
 * Order is preserved by clamping: a scene can never be pushed past its
 * neighbours, because a timeline that crosses over itself would produce
 * captions in the wrong sequence rather than an error anyone could see.
 */
export function nudgeScenes(take: Take, m?: Manifest): { take: Take; applied: { label: string; ms: number; clamped: boolean }[] } {
  const wanted = new Map<string, number>();
  for (const st of m?.steps ?? []) {
    if (st.action === "scene" && st.nudge) wanted.set(st.label, st.nudge);
  }
  if (!wanted.size) return { take, applied: [] };

  const applied: { label: string; ms: number; clamped: boolean }[] = [];
  const GAP = 0.1; // scenes stay strictly ordered
  const sceneIdx = take.timeline.map((t, i) => (t.action === "scene" ? i : -1)).filter((i) => i >= 0);
  const timeline = take.timeline.map((t) => ({ ...t }));

  for (const [n, i] of sceneIdx.entries()) {
    const want = wanted.get(timeline[i].label ?? "");
    if (!want) continue;
    const prev = n > 0 ? timeline[sceneIdx[n - 1]].start + GAP : 0;
    const next = n < sceneIdx.length - 1 ? timeline[sceneIdx[n + 1]].start - GAP : take.duration;
    const target = timeline[i].start + want / 1000;
    const to = Math.min(Math.max(target, prev), Math.max(prev, next));
    const span = timeline[i].end - timeline[i].start;
    applied.push({ label: timeline[i].label ?? "?", ms: want, clamped: Math.abs(to - target) > 0.01 });
    timeline[i].start = to;
    timeline[i].end = to + span;
  }
  return { take: { ...take, timeline }, applied };
}

export function scenes(take: Take): TimelineEntry[] {
  return take.timeline.filter((t) => t.action === "scene");
}

/** Caption windows in *trimmed* video time. */
export function captionWindows(take: Take): { text: string; from: number; to: number }[] {
  const sc = scenes(take);
  const end = take.duration - take.trimBefore;
  return sc
    .map((s, i) => {
      if (!s.caption) return null;
      const from = Math.max(0, s.start - take.trimBefore);
      const next = sc[i + 1] ? sc[i + 1].start - take.trimBefore : end;
      const to = s.holdMs ? Math.min(next, from + s.holdMs / 1000) : next;
      return { text: s.caption, from, to };
    })
    .filter((x): x is { text: string; from: number; to: number } => !!x);
}

// --- camera ------------------------------------------------------------------

type Key = { t: number; z: number; cx: number; cy: number };

/** Piecewise-linear ffmpeg expression over `T` for one field of the keyframes. */
function pw(keys: Key[], f: keyof Omit<Key, "t">, T = "t"): string {
  if (!keys.length) return "1";
  const v = (k: Key) => k[f].toFixed(4);
  let expr = v(keys[keys.length - 1]);
  for (let i = keys.length - 1; i >= 1; i--) {
    const a = keys[i - 1], b = keys[i];
    const seg = b.t - a.t > 0.001 ? `(${v(a)}+(${v(b)}-${v(a)})*(${T}-${a.t.toFixed(3)})/${(b.t - a.t).toFixed(3)})` : v(b);
    expr = `if(lt(${T},${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return `if(lt(${T},${keys[0].t.toFixed(3)}),${v(keys[0])},${expr})`;
}

/** Build the zoompan filter for the scenes that carry a camera. Camera eases in
    over 0.6s at each scene start and holds until the next scene. */
function cameraFilter(take: Take, W: number, H: number, fps: number): { filter: string; count: number } {
  const sc = scenes(take);
  const keys: Key[] = [];
  const centre: Key = { t: 0, z: 1, cx: W / 2, cy: H / 2 };
  let cur = { ...centre };
  let count = 0;
  const EASE = 0.6;
  for (const s of sc) {
    const t0 = Math.max(0, s.start - take.trimBefore);
    let target: Key;
    // A zoom may never crop the thing it points at: clamp so the focus box
    // (plus a margin) fits the window. Full-width elements get no zoom.
    const MARGIN = 28;
    const fit = s.camera ? Math.min(s.camera.zoom, W / (s.camera.box.width + 2 * MARGIN), H / (s.camera.box.height + 2 * MARGIN)) : 1;
    if (s.camera && fit >= 1.08) {
      count++;
      const b = s.camera.box;
      const z = Math.round(fit * 100) / 100;
      // Centre on the box, then clamp so the crop stays inside the frame.
      const halfW = W / (2 * z), halfH = H / (2 * z);
      const cx = Math.min(Math.max(b.x + b.width / 2, halfW), W - halfW);
      const cy = Math.min(Math.max(b.y + b.height / 2, halfH), H - halfH);
      target = { t: t0 + EASE, z, cx, cy };
      s.camera.zoom = z; // record what was actually used (proof log)
    } else {
      if (s.camera) s.camera = undefined; // focus fills the frame — no move

      target = { ...centre, t: t0 + EASE };
    }
    keys.push({ ...cur, t: t0 });
    keys.push(target);
    cur = { ...target };
  }
  if (!count) return { filter: "", count: 0 };
  const T = `(in/${fps})`;
  const z = pw(keys, "z", T);
  const cx = pw(keys, "cx", T);
  const cy = pw(keys, "cy", T);
  const x = `max(0,min(iw-iw/(${z}),(${cx})-iw/(2*(${z}))))`;
  const y = `max(0,min(ih-ih/(${z}),(${cy})-ih/(2*(${z}))))`;
  return { filter: `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${fps}`, count };
}

// --- card frame --------------------------------------------------------------

type CardGeom = { vx: number; vy: number; vw: number; vh: number; bandY: number };

function cardGeometry(W: number, H: number, SW: number, SH: number, bandHeight: number): CardGeom {
  const ms = Math.round(W * 0.055);
  const mt = Math.round(H * 0.06);
  const mb = Math.round(H * 0.035);
  const aw = W - 2 * ms;
  const ah = H - mt - bandHeight - mb;
  let vw = aw, vh = Math.round((aw * SH) / SW);
  if (vh > ah) { vh = ah; vw = Math.round((ah * SW) / SH); }
  vw -= vw % 2; vh -= vh % 2;
  const vx = Math.round((W - vw) / 2), vy = mt;
  return { vx, vy, vw, vh, bandY: vy + vh + mb };
}

/** A PNG the size of the canvas: soft background everywhere, a rounded
    transparent hole where the video sits, and a shadow around it. */
async function renderCardFrame(file: string, W: number, H: number, g: CardGeom, bg: string): Promise<void> {
  const html = `<!doctype html><body style="margin:0;background:transparent"><canvas id=c width=${W} height=${H}></canvas><script>
    const c=document.getElementById('c'),x=c.getContext('2d');
    const r=${Math.round(Math.min(g.vw, g.vh) * 0.022)};
    const rr=(X,Y,w,h,R)=>{x.beginPath();x.moveTo(X+R,Y);x.arcTo(X+w,Y,X+w,Y+h,R);x.arcTo(X+w,Y+h,X,Y+h,R);x.arcTo(X,Y+h,X,Y,R);x.arcTo(X,Y,X+w,Y,R);x.closePath();};
    x.fillStyle='${bg}';x.fillRect(0,0,${W},${H});
    x.save();x.shadowColor='rgba(20,30,20,0.28)';x.shadowBlur=${Math.round(H * 0.045)};x.shadowOffsetY=${Math.round(H * 0.012)};x.fillStyle='#000';rr(${g.vx},${g.vy},${g.vw},${g.vh},r);x.fill();x.restore();
    x.globalCompositeOperation='destination-out';rr(${g.vx},${g.vy},${g.vw},${g.vh},r);x.fill();
    x.globalCompositeOperation='source-over';x.strokeStyle='rgba(0,0,0,0.10)';x.lineWidth=1;rr(${g.vx}+0.5,${g.vy}+0.5,${g.vw}-1,${g.vh}-1,r);x.stroke();
  </script></body>`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForTimeout(80);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: W, height: H } });
  } finally {
    await browser.close();
  }
}

// --- render ------------------------------------------------------------------

export async function render(m: Manifest, takeIn: Take, outDir: string, opts: RenderOptions | ((l: string) => void) = {}): Promise<Artifacts> {
  let take = takeIn;
  const o = typeof opts === "function" ? { log: opts } : opts;
  const log = o.log;
  const q = resolve(m);
  // Before anything reads a scene time: markers move at render, so captions,
  // stills and the thumbnail all shift together and none of it costs a take.
  {
    const n = nudgeScenes(take, m);
    take = n.take;
    for (const a of n.applied) {
      log?.(`scene "${a.label}" moved ${a.ms > 0 ? "+" : ""}${(a.ms / 1000).toFixed(1)}s${a.clamped ? " (clamped — it would have crossed a neighbouring scene)" : ""}`);
    }
  }
  const proofLog = path.join(outDir, "proof-log.md");
  const writeProof = (a: Partial<Artifacts>) => fs.writeFileSync(proofLog, renderProof(m, take, q, a));
  // An output directory that cannot say what produced it makes an audit
  // guesswork: the manifest on disk today is not necessarily the one this
  // was rendered from. Keep a copy beside the take.
  if (!o.scene) {
    try { fs.writeFileSync(path.join(outDir, "manifest.used.yaml"), YAML.stringify(m)); } catch { /* not fatal */ }
  }
  if (!o.scene) writeProof({});
  if (!take.video) return { proofLog };
  const srcVideo: string = take.video;

  // Cache: nothing that shapes the picture changed → keep what's there.
  const hash = renderHash(m, take);
  const factsPath = path.join(outDir, "facts.json");
  if (!o.force && !o.scene && fs.existsSync(factsPath) && fs.existsSync(path.join(outDir, "demo.mp4"))) {
    try {
      const prev = JSON.parse(fs.readFileSync(factsPath, "utf8")) as Facts;
      if (prev.renderHash === hash) {
        log?.(`render: unchanged (${hash}) — reusing demo.mp4`);
        const a: Artifacts = { mp4: path.join(outDir, "demo.mp4"), proofLog, facts: { ...prev, cached: true } };
        for (const [k, f] of [["master", "master.mp4"], ["gif", "demo.gif"], ["thumbnail", "thumbnail.png"]] as const) if (fs.existsSync(path.join(outDir, f))) (a as Record<string, unknown>)[k] = path.join(outDir, f);
        writeProof(a);
        return a;
      }
    } catch { /* re-render */ }
  }
  // Captions, holds, camera zooms and trim come from the manifest as it is now.
  take = applyManifest(m, take);
  // Idle compression: re-cut the source so the app's dead waits are shown
  // short, and remap every clock in the take through the same warp.
  let idleLines: string[] = [];
  if (m.compressIdle && take.video) {
    const keep = m.compressIdle === true ? 1.5 : m.compressIdle.keepSeconds;
    const segs = planIdle(take, keep);
    if (segs.length) {
      const paced = path.join(outDir, ".paced.mp4");
      ff([...warpFilterArgs(take.video, segs, take.duration, paced).slice(0, -1), "-r", String(resolve(m).fps), "-c:v", "libx264", "-crf", "14", "-preset", "veryfast", "-pix_fmt", "yuv420p", paced], log);
      idleLines = describeIdle(take, segs);
      for (const l of idleLines) log?.(`idle: ${l}`);
      take = { ...warpTake(take, segs), video: paced };
    }
  }
  // Tempo: the source is cut in its own time (-ss/-t below), then every
  // clock downstream — captions, camera keys, stills — runs in output time.
  const srcTake = take;
  const tempo = m.tempo ?? 1;
  if (tempo !== 1) {
    const k = 1 / tempo;
    take = { ...take, trimBefore: take.trimBefore * k, duration: take.duration * k, timeline: take.timeline.map((e) => ({ ...e, start: e.start * k, end: e.end * k })) };
  }
  const t = { start: Date.now(), marks: {} as Record<string, number> };
  const mark = (k: string) => { const now = Date.now(); t.marks[k] = Math.round((now - t.start) / 100) / 10; t.start = now; };

  // Scene-only render: trim to that scene's window.
  if (o.scene) {
    const sc = scenes(take);
    const i = sc.findIndex((s) => s.label === o.scene);
    if (i < 0) throw new Error(`scene "${o.scene}" not found (${sc.map((s) => s.label).join(", ")})`);
    const from = sc[i].start;
    const to = sc[i + 1] ? sc[i + 1].start : take.duration;
    take = { ...take, trimBefore: from, duration: to };
  }

  const src = path.resolve(take.video ?? srcVideo); // take.video may be the idle-warped re-cut
  // Source (recorded viewport) vs canvas (preset output). They differ when a
  // narrow app was recorded at its own aspect and gets centred on the canvas.
  const SW = take.quality?.width ?? q.viewport.width;
  const SH = take.quality?.height ?? q.viewport.height;
  // band/overlay/none: the canvas IS the recording (site fills the frame).
  // card: the preset canvas, with the recording framed inside it.
  // The finished frame is ALWAYS the preset's canvas. Whatever page size the
  // take was recorded at gets fitted into it below — so a size change is a
  // re-render, never a re-record, and one preset always means one shape.
  const W = q.width;
  const H = q.height;
  const fps = q.fps;
  const bg = q.theme.background;
  const ink = q.theme.ink;
  const fontFile = DEFAULT_FONTS.find((f) => fs.existsSync(f));
  const font = fontFile ? `fontfile='${fontFile}':` : "";
  const layout = q.layout;

  // --- 1. compose master.mp4 -----------------------------------------------
  const filters: string[] = [...(tempo !== 1 ? [`setpts=PTS/${tempo}`] : []), `fps=${fps}`];
  // Scenes decided their cameras at record time (manifest policy + per-scene
  // overrides); render just honours whatever boxes were captured.
  const cam = cameraFilter(take, SW, SH, fps);
  if (cam.filter) filters.push(cam.filter);

  let capY = "";
  let capColor = q.captions ? q.captions.color ?? ink : ink;
  let capBox = "";
  let frameInput: string | null = null;
  let geom: CardGeom | null = null;
  const capSize = q.captions ? q.captions.fontSize : 0;
  // One band height for the whole take, from its captions (see captions.ts).
  const bandH = bandHeightFor(q, captionWindows(take).map((w) => w.text));

  if (layout === "band") {
    // Site fills the frame; caption strip below it — none at all if captions are off.
    // Fit the recording into the page area, letterboxing on the theme colour
    // rather than black, then the caption strip underneath. A take recorded
    // at 1440×1080 becomes a true 1920×1080, a 1080×1920, whatever is asked.
    const pageH = H - bandH;
    filters.push(`scale=${W}:${pageH}:force_original_aspect_ratio=decrease:flags=lanczos`, `pad=${W}:${pageH}:(ow-iw)/2:(oh-ih)/2:color=${bg}`);
    if (bandH) { filters.push(`pad=${W}:${H}:0:0:color=${bg}`); capY = `${pageH}+${bandH / 2}-th/2`; }
  } else if (layout === "card") {
    geom = cardGeometry(W, H, SW, SH, bandH);
    frameInput = path.join(outDir, ".frame.png");
    await renderCardFrame(frameInput, W, H, geom, bg);
    filters.push(`scale=${geom.vw}:${geom.vh}:flags=lanczos`, `pad=${W}:${H}:${geom.vx}:${geom.vy}:color=${bg}`);
    capY = `${geom.bandY}+(${H - geom.bandY})/2-th/2`;
  } else if (layout === "overlay-bottom" || layout === "overlay-top") {
    capY = layout === "overlay-top" ? "h*0.06" : "h-th-h*0.07";
    capColor = q.captions ? q.captions.color ?? "white" : "white";
    capBox = ":box=1:boxcolor=black@0.55:boxborderw=18";
  }
  // Square pixels, explicitly. Playwright's webm arrives with a SAR of
  // 1216:1215 — a half-percent stretch nobody notices until concat refuses
  // to join it to a title card that is honestly 1:1.
  filters.push("setsar=1", "format=yuv420p");

  const captionFilters: string[] = [];
  if (q.captions && layout !== "none") {
    const maxChars = maxCharsFor(W, capSize);
    for (const w of captionWindows(take)) {
      captionFilters.push(
        `drawtext=${font}text='${esc(wrap(w.text, maxChars))}':fontsize=${capSize}:fontcolor=${capColor}${capBox}:line_spacing=${Math.round(capSize * 0.25)}` +
          `:x=(w-tw)/2:y=${capY}:enable='between(t,${w.from.toFixed(2)},${w.to.toFixed(2)})'`,
      );
    }
  }

  // Callouts: recorded boxes become animated overlays, applied in SOURCE
  // coordinates (before the camera filter) so a moving camera carries them.
  const callouts = take.timeline.filter((e) => e.callout && e.ok);
  const calloutInputs: string[] = [];
  let preCam = "";
  if (callouts.length && !o.scene && !frameInput) {
    const camIdx = cam.filter ? filters.indexOf(cam.filter) : filters.length;
    const before = filters.slice(0, camIdx), after = filters.slice(camIdx);
    let label = "b0";
    let g = `[0:v]${before.join(",")}[${label}]`;
    for (let i = 0; i < callouts.length; i++) {
      const e = callouts[i];
      const from = Math.max(0, e.start - take.trimBefore);
      const webm = await renderCalloutOverlay(ffmpegBin(), outDir, i, e.callout!, SW, SH, fps, Math.max(15, Math.round(q.captions ? q.captions.fontSize * 0.55 : 20)), ink);
      calloutInputs.push(webm);
      const inIdx = 1 + (frameInput ? 1 : 0) + i;
      const next = `b${i + 1}`;
      g += `;[${inIdx}:v]setpts=PTS+${from.toFixed(3)}/TB[c${i}];[${label}][c${i}]overlay=0:0:eof_action=pass[${next}]`;
      label = next;
    }
    preCam = `${g};[${label}]${after.length ? after.join(",") : "null"}`;
  }
  const graph = preCam
    ? `${preCam}${captionFilters.length ? "," + captionFilters.join(",") : ""}[out]`
    : frameInput
    ? `[0:v]${filters.join(",")}[v];[v][1:v]overlay=0:0:format=auto${captionFilters.length ? "," + captionFilters.join(",") : ""}[out]`
    : `[0:v]${[...filters, ...captionFilters].join(",")}[out]`;
  const inputs = ["-ss", srcTake.trimBefore.toFixed(3), "-t", (srcTake.duration - srcTake.trimBefore).toFixed(3), "-i", src, ...(frameInput ? ["-i", frameInput] : []), ...calloutInputs.flatMap((f) => ["-c:v", "libvpx-vp9", "-i", f])];
  const compose = ["-filter_complex", graph, "-map", "[out]", "-r", String(fps), "-an", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  const x264 = (crf: number, preset: string) => ["-c:v", "libx264", "-crf", String(crf), "-preset", preset];
  // Hardware encode is a macOS thing; elsewhere the "fast" presets are a fast x264.
  const vt = process.platform === "darwin"
    ? ["-c:v", "h264_videotoolbox", "-b:v", `${Math.max(4, Math.round((W * H * fps * 0.15) / 1e6))}M`, "-allow_sw", "1"] // ~0.15 bit/px → ~9 Mbit/s at 1080p30
    : x264(20, "veryfast");

  const mp4 = path.join(outDir, o.scene ? `scene-${o.scene}.mp4` : "demo.mp4");
  let master: string | undefined;
  if (o.scene || q.encoder === "videotoolbox") {
    // One pass, hardware: compose straight into the deliverable.
    ff([...inputs, ...compose, ...vt, mp4], log);
    mark("compose+encode");
  } else if (q.master) {
    // Compose once into a CRF-14 master, then derive the deliverable.
    master = path.join(outDir, "master.mp4");
    ff([...inputs, ...compose, ...x264(14, "fast"), master], log);
    mark("compose");
    ff(["-i", master, ...x264(q.crf, "medium"), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4], log);
    mark("encode");
  } else {
    ff([...inputs, ...compose, ...x264(q.crf, "medium"), mp4], log);
    mark("compose+encode");
  }
  if (frameInput) fs.rmSync(frameInput, { force: true });
  for (const f of calloutInputs) fs.rmSync(f, { force: true });

  // Title cards: rendered at the finished frame size, spliced on. The intro's
  // settled frame becomes cover.png — the poster.
  let cover: string | undefined;
  if ((m.intro || m.outro) && !o.scene) {
    const dims = probe(mp4);
    const segs: string[] = [];
    if (m.intro) { const c = await renderCard(ffmpegBin(), outDir, "intro", m.intro, dims.width, dims.height, fps, q.theme); segs.push(c.mp4); cover = c.cover; }
    segs.push(mp4);
    if (m.outro) segs.push((await renderCard(ffmpegBin(), outDir, "outro", m.outro, dims.width, dims.height, fps, q.theme)).mp4);
    if (segs.length > 1) {
      const joined = path.join(outDir, ".joined.mp4");
      ff([...segs.flatMap((f) => ["-i", f]), "-filter_complex", `${segs.map((_, i) => `[${i}:v]`).join("")}concat=n=${segs.length}:v=1:a=0[out]`, "-map", "[out]", "-r", String(fps), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", ...x264(q.crf, "medium"), joined], log);
      fs.renameSync(joined, mp4);
      for (const f of segs) if (f !== mp4) fs.rmSync(f, { force: true });
    }
    mark("cards");
  }

  // Audio: the music bed and/or the captions read aloud, mixed in one pass.
  // The deliverable gets it; the master stays a clean video-only source.
  if ((m.music || m.voiceover) && !o.scene) {
    const dur = probe(mp4).duration;
    // Cards shift every scene: narration is placed in FINAL time.
    const introShift = m.intro ? m.intro.ms / 1000 : 0;
    const audioIn: string[] = [];
    const chains: string[] = [];
    const mixIns: string[] = [];
    let idx = 1; // 0 is the video
    if (m.music) {
      const spec = typeof m.music === "string" ? { file: m.music, gainDb: -14, fadeOutMs: 1800 } : m.music;
      const musicFile = path.resolve(expandEnv(spec.file));
      if (!fs.existsSync(musicFile)) throw new Error(`music: no such file ${musicFile} — the track ships inside the video, so it must be one the person may use (CC0 or licensed)`);
      const fadeStart = Math.max(0, dur - spec.fadeOutMs / 1000);
      // Ducked a step further when a voice speaks over it.
      const gain = spec.gainDb - (m.voiceover ? 7 : 0);
      audioIn.push("-stream_loop", "-1", "-i", musicFile);
      chains.push(`[${idx}:a]volume=${gain}dB,afade=t=in:st=0:d=0.6,afade=t=out:st=${fadeStart.toFixed(2)}:d=${(spec.fadeOutMs / 1000).toFixed(2)}[mus]`);
      mixIns.push("[mus]"); idx++;
    }
    if (m.voiceover) {
      const spec = m.voiceover === true ? { voice: DEFAULT_VOICE, gainDb: 0, script: undefined as string | undefined, fragments: true } : m.voiceover;
      if (spec.script) {
        // One script, one performance: prosody carries across the whole
        // video the way a person reads. Starts after the title card.
        const clip = path.join(outDir, ".vo-0.mp3");
        synthesize(spec.script, spec.voice, clip);
        const spoken = audioSeconds(ffmpegBin(), clip);
        if (spoken > dur - introShift + 0.5) log?.(`voiceover: the script reads ${spoken.toFixed(1)}s but there are ${(dur - introShift).toFixed(1)}s of video after the title card — cut the script or lengthen the scenes, then re-render`);
        audioIn.push("-i", clip);
        chains.push(`[${idx}:a]volume=${spec.gainDb}dB,adelay=${Math.round(introShift * 1000)}:all=1[vo0]`);
        mixIns.push("[vo0]"); idx++;
      } else {
        // Explicitly-asked-for fragments: one clip per caption. Known to
        // reset prosody at every line; the schema refuses it by default.
        const wins = captionWindows(take);
        for (let i = 0; i < wins.length; i++) {
          const w = wins[i];
          const clip = path.join(outDir, `.vo-${i}.mp3`);
          synthesize(w.text, spec.voice, clip);
          const spoken = audioSeconds(ffmpegBin(), clip);
          const at = w.from + introShift;
          if (spoken > w.to - w.from + 0.4) log?.(`voiceover: “${w.text.slice(0, 40)}…” runs ${spoken.toFixed(1)}s but its scene holds ${(w.to - w.from).toFixed(1)}s — lengthen the scene's holdMs or trailing wait and re-render`);
          audioIn.push("-i", clip);
          chains.push(`[${idx}:a]volume=${spec.gainDb}dB,adelay=${Math.round(at * 1000)}:all=1[vo${i}]`);
          mixIns.push(`[vo${i}]`); idx++;
        }
      }
    }
    const mixed = path.join(outDir, ".with-audio.mp4");
    const graph = `${chains.join(";")};${mixIns.join("")}amix=inputs=${mixIns.length}:duration=longest:normalize=0,atrim=0:${dur.toFixed(2)}[a]`;
    ff(["-i", mp4, ...audioIn, "-filter_complex", graph, "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-shortest", mixed], log);
    fs.renameSync(mixed, mp4);
    for (const f of fs.readdirSync(outDir)) if (/^\.vo-\d+\.mp3$/.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
    mark("audio");
  }
  if (o.scene) return { mp4, proofLog };

  // --- 3. GIF (secondary, opt-in) --------------------------------------------
  let gif: string | undefined;
  let gifTool: Facts["gifTool"] = "none";
  fs.rmSync(path.join(outDir, "demo.gif"), { force: true });
  if (q.gif) {
    gif = path.join(outDir, "demo.gif");
    const gk = gifskiBin();
    if (gk) {
      const frames = fs.mkdtempSync(path.join(os.tmpdir(), "retake-gif-"));
      try {
        ff(["-i", mp4, "-vf", `fps=${q.gif.fps},scale=${q.gif.width}:-2:flags=lanczos`, path.join(frames, "f%05d.png")], log);
        log?.(`$ gifski --fps ${q.gif.fps} --quality 90 -o demo.gif frames/*.png`);
        const files = fs.readdirSync(frames).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(frames, f));
        execFileSync(gk, ["--fps", String(q.gif.fps), "--quality", "90", "--width", String(q.gif.width), "-o", gif, ...files], { stdio: "ignore" });
        gifTool = "gifski";
      } finally {
        fs.rmSync(frames, { recursive: true, force: true });
      }
    } else {
      ff(["-i", mp4, "-vf", `fps=${q.gif.fps},scale=${q.gif.width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a`, "-loop", "0", gif], log);
      gifTool = "ffmpeg";
    }
    mark("gif");
  }

  // Cards are spliced onto the front of the deliverable, so every timestamp
  // in the take is that much later in the file frames are pulled from.
  const cardShift = !o.scene && m.intro ? m.intro.ms / 1000 : 0;

  // --- 4. thumbnail ----------------------------------------------------------
  // A person's chosen poster (the window's "Use this frame" / a still / an
  // upload) outlives re-renders: the choice writes a .poster marker, and the
  // scene-based default never overwrites a deliberate choice.
  let thumbnail: string | undefined;
  if (m.outputs.thumbnail && fs.existsSync(path.join(outDir, ".poster")) && fs.existsSync(path.join(outDir, "thumbnail.png"))) {
    thumbnail = path.join(outDir, "thumbnail.png");
    log?.("thumbnail: keeping the poster you chose (delete .poster to go back to the scene default)");
  } else if (m.outputs.thumbnail) {
    const sc = scenes(take);
    let at: number;
    if (typeof m.outputs.thumbnail === "object") {
      const want = m.outputs.thumbnail.scene;
      const s = sc.find((x) => x.label === want);
      // On a take that stopped early the chosen scene may never have happened;
      // fall back to the last scene that did rather than failing the render.
      const pick = s ?? sc.at(-1);
      at = pick ? pick.start - take.trimBefore + 1.0 : Math.max(0, take.duration - take.trimBefore - 0.5);
      if (!s) log?.(`thumbnail: scene "${want}" never happened — using ${pick ? `"${pick.label}"` : "the end"}`);
    } else {
      const last = sc.at(-1);
      at = last ? last.start - take.trimBefore + 1.0 : Math.max(0, take.duration - take.trimBefore - 0.5);
    }
    thumbnail = path.join(outDir, "thumbnail.png");
    // Clamp inside the file. The default is "last scene + 1s", which lands
    // PAST the end whenever a take stops soon after its final scene — ffmpeg
    // then writes nothing and the render died on the missing file, reported
    // in the field as "all steps ok, but no video".
    const seekable = Math.max(0, probe(mp4).duration - 0.25);
    const seek = Math.min(Math.max(0, at + cardShift), seekable);
    ff(["-ss", seek.toFixed(2), "-i", mp4, "-frames:v", "1", thumbnail], log);
    if (!fs.existsSync(thumbnail)) {
      log?.(`thumbnail: nothing at ${seek.toFixed(1)}s — taking the last frame instead`);
      ff(["-sseof", "-0.3", "-i", mp4, "-frames:v", "1", thumbnail], log);
    }
    if (!fs.existsSync(thumbnail)) { log?.("thumbnail: could not be taken — the video is fine, the poster is not"); thumbnail = undefined; }
    // A launch cut gets a second candidate: this frame with the title on it.
    // The person picks between them (or any still, or their own file) in the
    // window; both are just PNGs, and the poster is whichever is thumbnail.png.
    if (m.mode === "launch" && m.intro && thumbnail) {
      const d = probe(mp4);
      await renderTitledCover(ffmpegBin(), thumbnail, path.join(outDir, "cover-titled.png"), m.intro, d.width, d.height, q.theme);
    }
    mark("thumbnail");
  }
  // A launch cut is a thing someone signs off, so give them the artifact
  // that makes signing off possible without ffmpeg by hand.
  if (m.mode === "launch" && !o.scene && fs.existsSync(path.join(outDir, "demo.mp4"))) {
    try { contactSheet(outDir, 2, 420, undefined); mark("contact"); } catch (e) { log?.(`contact sheet: ${(e as Error).message}`); }
  }

  // --- 5. scene stills -------------------------------------------------------
  // Every scene already carries its real timestamp, so one crisp frame per
  // scene is free — and a video usually ships with a picture next to it.
  let stills: string[] = [];
  // Every still in ONE ffmpeg pass: a process launch and a fresh decode per
  // frame cost more than the frames do (7 stills was 3s of pure overhead).
  const shots: { at: number; file: string }[] = [];
  if (m.outputs.stills) {
    const dir = path.join(outDir, "stills");
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const sc = scenes(take);
    const end = take.duration - take.trimBefore;
    for (const [i, sce] of sc.entries()) {
      // The scene's midpoint: at the start the click hasn't landed, at the
      // end the scene may already be leaving (a save, a reset, a navigation).
      const next = sc[i + 1] ? sc[i + 1].start - take.trimBefore : end;
      const from = sce.start - take.trimBefore;
      const at = Math.min(Math.max(0, from + Math.max(0.8, (next - from) / 2)), Math.max(0, end - 0.2));
      const base = `${String(i + 1).padStart(2, "0")}-${(sce.label || "scene").replace(/[^a-z0-9-]+/gi, "-")}`;
      const file = path.join(dir, `${base}.png`);
      shots.push({ at: at + cardShift, file });
      stills.push(file);
      // And the scene's last moment: the caption names what the scene
      // achieves, and that is usually on screen at the end, not the middle.
      const atEnd = Math.min(Math.max(from + 0.4, next - 0.6), Math.max(0, end - 0.2));
      if (atEnd - at > 0.5) { const fe = path.join(dir, `${base}-end.png`); shots.push({ at: atEnd + cardShift, file: fe }); stills.push(fe); }
    }
    if (shots.length) {
      // Each still is its own ffmpeg with an INPUT-side seek: `-ss` before
      // `-i` jumps by keyframe, while one batched process with `-ss` after
      // `-i` decodes sequentially to every timestamp and is far slower (it
      // turned 3s of stills into 18s — measured, then reverted). The launches
      // are independent, so they run at once instead of in a queue.
      const bin = ffmpegBin();
      await Promise.all(shots.map((s) => new Promise<void>((done) => {
        execFile(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", s.at.toFixed(2), "-i", mp4, "-frames:v", "1", s.file], () => done());
      })));
      stills = stills.filter((f) => fs.existsSync(f));
    }
    if (sc.length) mark(`stills ×${sc.length}`);
  }
  if (!master) fs.rmSync(path.join(outDir, "master.mp4"), { force: true });

  const p = probe(mp4);
  const facts: Facts = {
    width: p.width, height: p.height, fps: p.fps || fps, duration: p.duration,
    sizes: Object.fromEntries([master, mp4, gif, thumbnail].filter((f): f is string => !!f && fs.existsSync(f)).map((f) => [path.basename(f), fs.statSync(f).size])),
    gifTool, layout, cameraScenes: cam.count, encoder: q.encoder, timings: t.marks, renderHash: hash, preset: q.name,
    mode: m.mode,
  };
  const a: Artifacts = { master, mp4, gif, thumbnail, proofLog, facts };
  writeProof(a);
  fs.writeFileSync(factsPath, JSON.stringify({ ...facts, check: check(outDir, m) }, null, 2));
  return a;
}

/** GIF straight from the finished demo.mp4 — no re-render, no browser. */
/** One timestamped contact sheet of the finished video.
 *
 * Reviewing a take meant pulling frames out with ffmpeg by hand, a dozen
 * timestamps at a time, eight videos deep. This is that, once: a grid with
 * the playback time burned into every cell, so a still can be reasoned about
 * as a moment rather than a picture. Per-scene stills cannot do this — they
 * cannot show a caption going false *inside* a scene, and they carry no clock.
 */
export function contactSheet(outDir: string, everySec = 2, width = 420, log?: (l: string) => void): string {
  const mp4 = path.join(outDir, "demo.mp4");
  if (!fs.existsSync(mp4)) throw new Error(`no demo.mp4 in ${outDir} — render it first`);
  const dur = probe(mp4).duration;
  const cells = Math.max(1, Math.ceil(dur / everySec));
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(cells))));
  const rows = Math.ceil(cells / cols);
  const fontFile = DEFAULT_FONTS.find((f) => fs.existsSync(f));
  const font = fontFile ? `fontfile='${fontFile}':` : "";
  const out = path.join(outDir, "contact.png");
  // drawtext runs before tile, so each cell carries its own playback time.
  const vf = [
    `fps=1/${everySec}`,
    `scale=${width}:-2`,
    `drawtext=${font}text='%{pts\\:hms}':x=8:y=8:fontsize=${Math.round(width / 20)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=5`,
    `tile=${cols}x${rows}:margin=8:padding=6:color=#e6e9e2`,
  ].join(",");
  ff(["-i", mp4, "-vf", vf, "-frames:v", "1", out], log);
  if (!fs.existsSync(out)) throw new Error("ffmpeg produced no contact sheet");
  log?.(`contact: ${cells} frames every ${everySec}s, ${cols}×${rows} → ${path.relative(process.cwd(), out)}`);
  return out;
}

export function makeGif(outDir: string, width = 900, fps = 18, log?: (l: string) => void): string {
  const mp4 = path.join(outDir, "demo.mp4");
  if (!fs.existsSync(mp4)) throw new Error("no demo.mp4 to make a GIF from — run the demo first");
  const gif = path.join(outDir, "demo.gif");
  const gk = gifskiBin();
  if (gk) {
    const frames = fs.mkdtempSync(path.join(os.tmpdir(), "retake-gif-"));
    try {
      ff(["-i", mp4, "-vf", `fps=${fps},scale=${width}:-2:flags=lanczos`, path.join(frames, "f%05d.png")], log);
      const files = fs.readdirSync(frames).filter((f) => f.endsWith(".png")).sort().map((f) => path.join(frames, f));
      execFileSync(gk, ["--fps", String(fps), "--quality", "90", "--width", String(width), "-o", gif, ...files], { stdio: "ignore" });
    } finally {
      fs.rmSync(frames, { recursive: true, force: true });
    }
  } else {
    ff(["-i", mp4, "-vf", `fps=${fps},scale=${width}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=192:stats_mode=diff[p];[s1][p]paletteuse=dither=sierra2_4a`, "-loop", "0", gif], log);
  }
  const factsPath = path.join(outDir, "facts.json");
  if (fs.existsSync(factsPath)) {
    try {
      const f = JSON.parse(fs.readFileSync(factsPath, "utf8"));
      f.sizes = { ...f.sizes, "demo.gif": fs.statSync(gif).size };
      f.gifTool = gk ? "gifski" : "ffmpeg";
      fs.writeFileSync(factsPath, JSON.stringify(f, null, 2));
    } catch { /* ignore */ }
  }
  return gif;
}

// --- check -------------------------------------------------------------------

export type Check = { ok: boolean; lines: string[] };

/** Did the folder come out post-worthy? Pass/fail per fact, no opinions. */
export function check(outDir: string, m?: Manifest): Check {
  const lines: string[] = [];
  let ok = true;
  const say = (pass: boolean, text: string) => { lines.push(`${pass ? "pass" : "FAIL"}  ${text}`); if (!pass) ok = false; };
  const takePath = path.join(outDir, "take.json");
  // A run killed outright (a signal, a closed pipe) leaves its predecessor in
  // the stash with no catch block ever running. Anything that READS the folder
  // puts it back, so a person looking at it never sees an empty directory and
  // concludes their take is gone.
  if (!fs.existsSync(takePath)) restorePrevious(outDir);
  if (!fs.existsSync(takePath)) return { ok: false, lines: ["FAIL  no take.json"] };
  // The same shift render applied, so a nudged scene is not reported as a
  // stall or a caption in the wrong place by a check reading raw times.
  const take = nudgeScenes(JSON.parse(fs.readFileSync(takePath, "utf8")) as Take, m).take;
  // The take knows which preset it was recorded with; a `--preset` on the run
  // must win over the manifest's default, or a draft fails for lacking a master.
  const q = m ? resolve(take.quality?.preset && take.quality.preset !== m.preset ? { ...m, preset: take.quality.preset } : m) : null;
  const mp4 = path.join(outDir, "demo.mp4");
  if (!fs.existsSync(mp4)) return { ok: false, lines: ["FAIL  demo.mp4 missing"] };
  const p = probe(mp4);
  const wantW = q?.width;
  say(true, `resolution: ${p.width}×${p.height}`);
  if (wantW) say(p.width === wantW, `matches ${q?.name}: ${wantW}px wide`);
  say(p.width >= 960, `at least 960px wide`);
  say(true, `fps: ${p.fps}`);
  /* A take may legitimately run long — a full product walkthrough does.
     The manifest's own maxSeconds is the author's stated bound; a take
     inside it is not a runaway, so do not fail it for length. */
  const longest = m ? capSecondsFor(m) : 300;
  say(p.duration >= 5 && p.duration <= longest, `duration: ${p.duration.toFixed(1)}s`);
  if (p.duration > 60) lines.push(`—     ${p.duration.toFixed(0)}s is long for a social post (aim for 15–45s); fine for a walkthrough`);
  /* A step that stalls is not a failed step, so nothing above notices it — but
     the camera keeps rolling on the last painted frame and the viewer watches
     a still image for the duration. One 46s navigation shipped in a take whose
     other seven navigations took under four seconds; every check passed.
     `wait` and `scene` are excluded because their whole job is to take time. */
  const PATIENCE = 8;
  // Judge what shipped. compressIdle rewrites the timeline at render, so
  // reading raw step durations here failed good videos for a stall the
  // viewer never sees — and a check that cries wolf teaches you to skim
  // past the one that matters.
  const idleSegs = m?.compressIdle && take.video
    ? planIdle(take, m.compressIdle === true ? 1.5 : m.compressIdle.keepSeconds)
    : [];
  const shownTake = idleSegs.length ? warpTake(take, idleSegs) : take;
  const stalled = (shownTake.timeline || [])
    .filter((t) => t.action !== "wait" && t.action !== "scene" && t.action !== "stub")
    .map((t) => ({ ...t, took: t.end - t.start }))
    .filter((t) => t.took > PATIENCE)
    .sort((a, b) => b.took - a.took);
  // Did the app break, and was it still broken when the video stopped? A
  // take can pass every step and end on an error screen; one did, and only
  // frame-by-frame review found it. An error in the last stretch is the
  // shape that matters — earlier ones are usually recovered from.
  const errs = take.pageErrors ?? [];
  if (errs.length) {
    const endsAt = take.duration;
    const late = errs.filter((e) => e.at >= Math.max(0, endsAt - 6));
    if (late.length) {
      say(false, `the app reported an error in the last seconds and the video ends on it: “${late[0].text.slice(0, 120)}” at ${late[0].at.toFixed(1)}s — watch the final frames before shipping this`);
    } else {
      lines.push(`—     the app reported ${errs.length} error${errs.length > 1 ? "s" : ""} during the take (earliest “${errs[0].text.slice(0, 80)}”), none in the last 6s`);
    }
  }
  if (stalled.length) {
    const worst = stalled[0];
    // A timestamp says a stall happened; it cannot say why. The frame can —
    // a spinner, a modal, an error, or the app simply sitting there are four
    // different problems and "25.5s at 0:56" is the same sentence for all of
    // them. Pulled from the finished video, so it costs a seek, not a take.
    const shots: string[] = [];
    const trim = shownTake.trimBefore ?? 0;
    for (const [i, t] of stalled.slice(0, 3).entries()) {
      // A third of the way in: past whatever triggered it, still inside the
      // held stretch rather than on the frame that ends it.
      const at = Math.max(0, t.start - trim + Math.min(t.took / 3, 4));
      const file = path.join(outDir, `stalled-${String(i + 1).padStart(2, "0")}.png`);
      try {
        ff(["-ss", at.toFixed(2), "-i", mp4, "-frames:v", "1", "-y", file]);
        if (fs.existsSync(file)) shots.push(path.relative(process.cwd(), file));
      } catch { /* a picture is a bonus, never the reason a check fails */ }
    }
    say(false, `${stalled.length} step${stalled.length > 1 ? "s" : ""} stalled over ${PATIENCE}s — ` +
      `the take holds a still frame there. Worst: ${worst.took.toFixed(1)}s at ` +
      `${Math.floor(worst.start / 60)}:${String(Math.floor(worst.start % 60)).padStart(2, "0")} — ${worst.summary}`);
    if (shots[0]) lines.push(`—     what the frame shows there: ${shots[0]} — open it; a spinner, a modal and an idle app are three different fixes`);
    for (const [i, t] of stalled.slice(1, 4).entries()) {
      lines.push(`—     also ${t.took.toFixed(1)}s: ${t.summary}${shots[i + 1] ? ` (${shots[i + 1]})` : ""}`);
    }
  } else {
    say(true, `no step stalled (nothing over ${PATIENCE}s)`);
  }

  // A stub nobody asked for is a silent lie: the take passes and the screen
  // shows live data where the demo promised canned. Worth a failed check, not
  // a footnote — this is the one the reporter spent a morning on.
  const dead = Object.entries(take.stubHits ?? {}).filter(([, n]) => !n).map(([k]) => k);
  if (take.stubbed?.length) {
    if (dead.length) say(false, `${dead.length} stub${dead.length > 1 ? "s" : ""} never answered a request: ${dead.join(", ")} — those screens showed the app's real data. Check the URL pattern matches, and that the page actually re-fetched (a navigate that changes only the #fragment does not reload an SPA).`);
    else say(true, `all ${take.stubbed.length} stub${take.stubbed.length > 1 ? "s" : ""} answered at least one request`);
  }

  const mb = (f: string) => (fs.statSync(f).size / 1e6).toFixed(1) + " MB";
  say(true, `demo.mp4: ${mb(mp4)}`);
  const master = path.join(outDir, "master.mp4");
  if (q?.master) say(fs.existsSync(master), `master.mp4 kept${fs.existsSync(master) ? ` (${mb(master)})` : ""}`); else lines.push(`—     master.mp4: not part of this preset`);
  const gif = path.join(outDir, "demo.gif");
  if (fs.existsSync(gif)) say(true, `demo.gif: ${mb(gif)} (secondary)`); else lines.push(`—     demo.gif: not requested`);
  if (!m || m.outputs.thumbnail) say(fs.existsSync(path.join(outDir, "thumbnail.png")), "thumbnail exists");
  else lines.push("—     thumbnail: not requested");
  say(fs.existsSync(path.join(outDir, "proof-log.md")), "proof log exists");
  say(take.ok, take.ok ? "all steps passed" : "some steps failed");
  say(!take.partial, take.partial ? `partial: ${take.partial}` : "polished render (not fallback)");
  if (take.partial && /NO CURSOR/.test(take.partial)) say(false, "cursor overlay failed — the video has no cursor (split the demo or set cursor: false)");
  const sc = scenes(m ? applyManifest(m, take) : take);
  say(sc.length >= 2, `${sc.length} scenes`);
  const cams = sc.filter((s) => s.camera).length;
  lines.push(`—     camera on ${cams}/${sc.length} scenes`);
  return { ok, lines };
}

// --- proof log ---------------------------------------------------------------

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, "0")}`;
}

function renderProof(m: Manifest, take: Take, q: Resolved, a: Partial<Artifacts>): string {
  const rows = take.timeline.map(
    (t) => `| ${t.index} | ${t.ok ? "✓" : "✗"} | ${fmt(t.start - take.trimBefore)} | ${fmt(t.end - take.trimBefore)} | ${t.summary.replace(/\|/g, "\\|")}${t.camera ? ` · camera ${t.camera.zoom}× → ${t.camera.focus}` : ""}${t.error ? ` — _${t.error}_` : ""} |`,
  );
  const f = a.facts;
  const size = (k: "master" | "mp4" | "gif" | "thumbnail") => {
    const file = a[k];
    if (!file) return "—";
    const b = path.basename(file);
    const n = f?.sizes[b];
    return `${b}${n ? ` (${(n / 1e6).toFixed(1)} MB)` : ""}`;
  };
  return [
    `# Proof log — ${m.name}`,
    "",
    `- URL: ${m.url}`,
    `- Preset: ${q.name} · canvas ${q.width}×${q.height} · viewport ${take.quality?.width ?? q.viewport.width}×${take.quality?.height ?? q.viewport.height} @ ${q.fps}fps · page scale ${q.scale}× · layout ${q.layout}`,
    // Measured during the take, not computed from the preset: `zoom` does not
    // move an app's media queries, so width÷scale would be a plausible lie.
    // Named outright because a responsive app serves a different layout below
    // a breakpoint, and this is the number that explains which one you filmed.
    ...(take.layoutWidth ? [`- Page laid out at: **${take.layoutWidth} CSS px** wide — the width this app's own breakpoints saw.`] : []),
    `- Started: ${take.startedAt}`,
    `- Finished: ${take.finishedAt}`,
    `- Result: **${take.ok ? "all steps passed" : "some steps failed"}**${take.partial ? ` · **partial** — ${take.partial}` : ""}`,
    `- Setup trimmed: ${take.trimBefore.toFixed(1)}s · final length ≈ ${(take.duration - take.trimBefore).toFixed(1)}s`,
    // A nudged demo no longer matches raw step timing; say so, or the next
    // person reads the timeline against the video and thinks one is wrong.
    ...(() => {
      const n = (m.steps ?? []).filter((st) => st.action === "scene" && st.nudge).map((st) => `${(st as { label: string }).label} ${(st as { nudge: number }).nudge > 0 ? "+" : ""}${((st as { nudge: number }).nudge / 1000).toFixed(1)}s`);
      return n.length ? [`- **Scene markers moved at render**: ${n.join(", ")} — the captions and stills follow these, not the raw step times below.`] : [];
    })(),
    ...(take.stubbed?.length ? [`- **Stubbed data**: ${take.stubbed.map((k) => `${k}${take.stubHits ? ` (${take.stubHits[k] ?? 0} request${(take.stubHits[k] ?? 0) === 1 ? "" : "s"})` : ""}`).join(", ")} — these screens were fed canned responses, not a live backend.`] : []),
    ...(take.stubHits && Object.entries(take.stubHits).some(([, n]) => !n)
      ? [`- **Stubs that never fired**: ${Object.entries(take.stubHits).filter(([, n]) => !n).map(([k]) => k).join(", ")} — armed, but no request matched, so those screens showed whatever the app really returned. Usually the pattern does not match the real URL, or the page never re-fetched (a navigation that only changes the #fragment does not reload an SPA).`]
      : []),
    "",
    "## Artifacts",
    "",
    `- master: ${size("master")}`,
    `- mp4: ${size("mp4")}`,
    `- gif: ${size("gif")}`,
    `- thumbnail: ${size("thumbnail")}`,
    `- stills: per scene in stills/ — NN-label.png is the MIDDLE of the scene, NN-label-end.png its last moment (the payoff). Judge 'did it happen' from -end, 'what was it doing' from the middle.`,
    ...(f ? [`- output: ${f.width}×${f.height} @ ${f.fps}fps · ${f.duration.toFixed(1)}s · ${f.encoder} · gif via ${f.gifTool} · camera on ${f.cameraScenes} scenes${f.cached ? " · cached" : ""}`, `- render time: ${Object.entries(f.timings ?? {}).map(([k, v]) => `${k} ${v}s`).join(" · ") || "—"}`] : []),
    "",
    "## Shot list",
    "",
    ...scenes(take).map((s) => `- **${fmt(s.start - take.trimBefore)}** ${s.label}${s.caption ? ` — “${s.caption}”` : ""}`),
    "",
    "## Timeline",
    "",
    "| # | ok | start | end | step |",
    "|---|----|-------|-----|------|",
    ...rows,
    "",
  ].join("\n");
}
