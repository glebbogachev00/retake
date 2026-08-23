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
import { execFileSync, spawnSync } from "node:child_process";
import { capSecondsFor } from "./record.js";
import { bandHeightFor, maxCharsFor, wrap } from "./captions.js";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { resolve, type Manifest, type Resolved, type Step } from "./manifest.js";
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
  h.update(JSON.stringify({ q, tempo: m.tempo, cap: m.captions, theme: m.theme, camera: m.camera, gif: m.outputs.gif, thumb: m.outputs.thumbnail, stills: m.outputs.stills, video: src ? [src.size, Math.round(src.mtimeMs)] : null, tl: merged.timeline.map((t) => [t.start, t.end, t.label, t.caption, t.holdMs, t.camera]), trim: [merged.trimBefore, merged.duration] }));
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

export async function render(m: Manifest, take: Take, outDir: string, opts: RenderOptions | ((l: string) => void) = {}): Promise<Artifacts> {
  const o = typeof opts === "function" ? { log: opts } : opts;
  const log = o.log;
  const q = resolve(m);
  const proofLog = path.join(outDir, "proof-log.md");
  const writeProof = (a: Partial<Artifacts>) => fs.writeFileSync(proofLog, renderProof(m, take, q, a));
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

  const src = path.resolve(srcVideo);
  // Source (recorded viewport) vs canvas (preset output). They differ when a
  // narrow app was recorded at its own aspect and gets centred on the canvas.
  const SW = take.quality?.width ?? q.viewport.width;
  const SH = take.quality?.height ?? q.viewport.height;
  // band/overlay/none: the canvas IS the recording (site fills the frame).
  // card: the preset canvas, with the recording framed inside it.
  const W = q.layout === "card" ? q.width : SW;
  const H = q.layout === "card" ? q.height : SH;
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
  const bandH = bandHeightFor(q, W, captionWindows(take).map((w) => w.text), H);

  if (layout === "band") {
    // Site fills the frame; caption strip below it — none at all if captions are off.
    if (bandH) { filters.push(`pad=${W}:${H + bandH}:0:0:color=${bg}`); capY = `${H}+${bandH / 2}-th/2`; }
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
  filters.push("format=yuv420p");

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

  const graph = frameInput
    ? `[0:v]${filters.join(",")}[v];[v][1:v]overlay=0:0:format=auto${captionFilters.length ? "," + captionFilters.join(",") : ""}[out]`
    : `[0:v]${[...filters, ...captionFilters].join(",")}[out]`;
  const inputs = ["-ss", srcTake.trimBefore.toFixed(3), "-t", (srcTake.duration - srcTake.trimBefore).toFixed(3), "-i", src, ...(frameInput ? ["-i", frameInput] : [])];
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

  // --- 4. thumbnail ----------------------------------------------------------
  let thumbnail: string | undefined;
  if (m.outputs.thumbnail) {
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
    ff(["-ss", Math.max(0, at).toFixed(2), "-i", mp4, "-frames:v", "1", thumbnail], log);
    mark("thumbnail");
  }
  // --- 5. scene stills -------------------------------------------------------
  // Every scene already carries its real timestamp, so one crisp frame per
  // scene is free — and a video usually ships with a picture next to it.
  let stills: string[] = [];
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
      ff(["-ss", at.toFixed(2), "-i", mp4, "-frames:v", "1", file], log);
      stills.push(file);
      // And the scene's last moment: the caption names what the scene
      // achieves, and that is usually on screen at the end, not the middle.
      const atEnd = Math.min(Math.max(from + 0.4, next - 0.6), Math.max(0, end - 0.2));
      if (atEnd - at > 0.5) { const fe = path.join(dir, `${base}-end.png`); ff(["-ss", atEnd.toFixed(2), "-i", mp4, "-frames:v", "1", fe], log); stills.push(fe); }
    }
    if (sc.length) mark(`stills ×${sc.length}`);
  }
  if (!master) fs.rmSync(path.join(outDir, "master.mp4"), { force: true });

  const p = probe(mp4);
  const facts: Facts = {
    width: p.width, height: p.height, fps: p.fps || fps, duration: p.duration,
    sizes: Object.fromEntries([master, mp4, gif, thumbnail].filter((f): f is string => !!f).map((f) => [path.basename(f), fs.statSync(f).size])),
    gifTool, layout, cameraScenes: cam.count, encoder: q.encoder, timings: t.marks, renderHash: hash, preset: q.name,
  };
  const a: Artifacts = { master, mp4, gif, thumbnail, proofLog, facts };
  writeProof(a);
  fs.writeFileSync(factsPath, JSON.stringify({ ...facts, check: check(outDir, m) }, null, 2));
  return a;
}

/** GIF straight from the finished demo.mp4 — no re-render, no browser. */
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
  if (!fs.existsSync(takePath)) return { ok: false, lines: ["FAIL  no take.json"] };
  const take = JSON.parse(fs.readFileSync(takePath, "utf8")) as Take;
  // The take knows which preset it was recorded with; a `--preset` on the run
  // must win over the manifest's default, or a draft fails for lacking a master.
  const q = m ? resolve(take.quality?.preset && take.quality.preset !== m.preset ? { ...m, preset: take.quality.preset } : m) : null;
  const mp4 = path.join(outDir, "demo.mp4");
  if (!fs.existsSync(mp4)) return { ok: false, lines: ["FAIL  demo.mp4 missing"] };
  const p = probe(mp4);
  const wantW = q ? (q.layout === "card" ? q.width : (take.quality?.width ?? q.viewport.width)) : undefined;
  say(true, `resolution: ${p.width}×${p.height}`);
  if (wantW) say(p.width === wantW, `matches expected width ${wantW}`);
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
  const stalled = (take.timeline || [])
    .filter((t) => t.action !== "wait" && t.action !== "scene" && t.action !== "stub")
    .map((t) => ({ ...t, took: t.end - t.start }))
    .filter((t) => t.took > PATIENCE)
    .sort((a, b) => b.took - a.took);
  if (stalled.length) {
    const worst = stalled[0];
    say(false, `${stalled.length} step${stalled.length > 1 ? "s" : ""} stalled over ${PATIENCE}s — ` +
      `the take holds a still frame there. Worst: ${worst.took.toFixed(1)}s at ` +
      `${Math.floor(worst.start / 60)}:${String(Math.floor(worst.start % 60)).padStart(2, "0")} — ${worst.summary}`);
    for (const t of stalled.slice(1, 4)) {
      lines.push(`—     also ${t.took.toFixed(1)}s: ${t.summary}`);
    }
  } else {
    say(true, `no step stalled (nothing over ${PATIENCE}s)`);
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
    `- Started: ${take.startedAt}`,
    `- Finished: ${take.finishedAt}`,
    `- Result: **${take.ok ? "all steps passed" : "some steps failed"}**${take.partial ? ` · **partial** — ${take.partial}` : ""}`,
    `- Setup trimmed: ${take.trimBefore.toFixed(1)}s · final length ≈ ${(take.duration - take.trimBefore).toFixed(1)}s`,
    ...(take.stubbed?.length ? [`- **Stubbed data**: ${take.stubbed.join(", ")} — these screens were fed canned responses, not a live backend.`] : []),
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
