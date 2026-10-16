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
import { launchChromium } from "./browser-home.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { capSecondsFor, restorePrevious } from "./record.js";
import { bandHeightFor, maxCharsFor, wrap } from "./captions.js";
import { renderCard, renderCalloutOverlay, renderPoster, renderTitledCover } from "./cards.js";
import { describeIdle, planIdle, warpFilterArgs, warpTake } from "./pace.js";
import { holdFilterArgs, holdTake, planHolds } from "./hold.js";
import { DEFAULT_VOICE, LOCAL_VOICE, LOCAL_VOICE_VERSION, audioSeconds, cueGroups, cuesPerParagraph, cutPoints, silences, synthesize, synthesizeWithCues } from "./voice.js";
import { expandEnv, resolve, Manifest, type Resolved, type Step } from "./manifest.js";
import type { Take, TimelineEntry } from "./record.js";
import { ffmpegBin } from "./media-bin.js";
export { ffmpegBin } from "./media-bin.js";

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
  /** Whether THIS render kept an archival master — not whether the preset
      would have. `--no-master` is a choice, and check has to respect it. */
  master?: boolean;
  renderHash: string;
  /** demo or launch — so an output says what it was made to be. */
  mode?: "demo" | "launch";
  preset: string;
  cached?: boolean;
};

export type RenderOptions = {
  /** Skip the archival CRF-14 master and compose straight to the deliverable.
      Halves render on a long take, and the deliverable is marginally BETTER
      for it: the master path encodes to CRF 14 and then re-encodes that to
      the delivery CRF, so the file you hand over is a compression of a
      compression. One pass encodes once, from the source frames. */
  noMaster?: boolean;
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
  h.update(JSON.stringify({ q, tempo: m.tempo, cap: m.captions, theme: m.theme, camera: m.camera, cards: [m.intro, m.outro, m.card, m.card ? [m.card.logo, m.card.font].map((f) => { try { const st = fs.statSync(path.resolve(f ?? "")); return [st.size, Math.round(st.mtimeMs)]; } catch { return null; } }) : null], idle: m.compressIdle, vo: m.voiceover, voEngine: typeof m.voiceover === "object" && LOCAL_VOICE.test(m.voiceover.voice) ? LOCAL_VOICE_VERSION : undefined, music: m.music ? [m.music, (() => { try { const f = typeof m.music === "string" ? m.music : m.music.file; const st = fs.statSync(path.resolve(f)); return [st.size, Math.round(st.mtimeMs)]; } catch { return null; } })()] : null, gif: m.outputs.gif, thumb: [m.outputs.thumbnail, m.outputs.cover], stills: m.outputs.stills, video: src ? [src.size, Math.round(src.mtimeMs)] : null, tl: merged.timeline.map((t) => [t.start, t.end, t.label, t.caption, t.holdMs, t.camera, t.callout]), trim: [merged.trimBefore, merged.duration] }));
  return h.digest("hex").slice(0, 12);
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

/** Whether a file carries a sound track at all. */
export function probeHasAudio(file: string): boolean {
  return /Stream #\d+:\d+.*: Audio:/.test(String(spawnSync(ffmpegBin(), ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr));
}

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
    else if (cam && typeof cam === "object" && e.camera) out.camera = {
      ...e.camera,
      ...(cam.zoom ? { zoom: cam.zoom } : {}),
      holdMs: cam.holdMs,
      easeMs: cam.easeMs,
    };
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

/** Each step's declared pause, in seconds, by its index in the timeline. */
function pausesOf(m: Manifest | undefined): (number | undefined)[] {
  return (m?.steps ?? []).map((st) => { const p = (st as { pauseAfter?: number }).pauseAfter; return p ? p / 1000 : undefined; });
}

export function scenes(take: Take): TimelineEntry[] {
  return take.timeline.filter((t) => t.action === "scene");
}

/** Caption windows in *trimmed* video time. */
/** Where the one performance is cut into its paragraphs: in the middle of
    the pause between lines, never on a sentence timing (which sits against
    the next word). Shared by the voice and the captions that follow it. */
function narrationBounds(clip: string, spans: { start: number; end: number }[], n: number): number[] {
  const total = audioSeconds(ffmpegBin(), clip);
  const quiet = silences(ffmpegBin(), clip);
  const inner = cutPoints(spans.slice(0, n - 1).map((sp, k) => (sp.end + spans[k + 1].start) / 2), quiet, total);
  const firstSpeech = quiet.length && quiet[0].start <= 0.02 ? quiet[0].end : 0;
  return [Math.max(0, firstSpeech - 0.05), ...inner, total];
}

/** The line starts as its scene starts: the scene marker sits BEFORE the
    action it describes, so the voice leads the cursor. */
const NARRATION_LEAD = 0.1;

/**
 * Captions that follow the voice: each spoken sentence on screen while it is
 * said, timed from the same performance and the same cuts the voice uses.
 * A narrated video captioned with its scene labels shows one thing and says
 * another; this shows what is said.
 */
function spokenCaptions(m: Manifest, take: Take, outDir: string): { text: string; from: number; to: number }[] | null {
  const vo = m.voiceover;
  if (!vo || vo === true || !vo.script || vo.align !== "scenes") return null;
  const paragraphs = vo.script.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const wins = narrationWindows(take);
  const clip = path.join(outDir, ".vo-0.mp3");
  const cues = synthesizeWithCues(paragraphs.join("\n\n"), vo.voice, clip, vo.ratePercent);
  const spans = cuesPerParagraph(paragraphs, cues);
  const groups = cueGroups(paragraphs, cues);
  const n = Math.min(spans.length, wins.length);
  if (!n) return null;
  const bounds = narrationBounds(clip, spans, n);
  // A translation shows its own sentences over the spoken ones: one for one
  // when they line up, else spread over the paragraph by length.
  const shown = vo.captionScript?.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences = (p: string) => p.split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean);
  const out: { text: string; from: number; to: number }[] = [];
  for (let k = 0; k < n; k++) {
    const at = wins[k].from + NARRATION_LEAD - bounds[k];
    const group = groups[k];
    if (!group.length) continue;
    const own = shown?.[k] ? sentences(shown[k]) : null;
    if (!own || own.length === group.length) {
      group.forEach((c, i) => out.push({ text: (own ? own[i] : c.text).trim(), from: Math.max(0, at + c.start), to: at + c.end + 0.2 }));
    } else {
      const from = group[0].start, to = group[group.length - 1].end;
      const total = own.reduce((s, x) => s + x.length, 0) || 1;
      let t = from;
      for (const line of own) { const len = (to - from) * line.length / total; out.push({ text: line, from: Math.max(0, at + t), to: at + t + len }); t += len; }
    }
  }
  // A caption leaves when the next one arrives, never overlapping it.
  for (let i = 0; i + 1 < out.length; i++) out[i].to = Math.min(out[i].to, out[i + 1].from);
  return out.filter((c) => c.text && c.to > c.from);
}

/** Where each paragraph of aligned narration may run: from its narrated
    scene to the NEXT NARRATED one, across any uncaptioned scenes between.
    Ending it at the next scene of any kind froze a home page for 5s so its
    line could finish while the tour's next, wordless scene waited. */
export function narrationWindows(take: Take): { text: string; from: number; to: number }[] {
  const sc = scenes(take);
  const end = take.duration - take.trimBefore;
  const said = sc.filter((s) => !!s.caption);
  return said.map((s, i) => ({
    text: s.caption!,
    from: Math.max(0, s.start - take.trimBefore),
    to: said[i + 1] ? said[i + 1].start - take.trimBefore : end,
  }));
}

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

export type CameraKey = { t: number; z: number; cx: number; cy: number };

/** Piecewise smoothstep expression over `T` for one field of the keyframes.
 * Linear camera travel starts and stops abruptly, which reads as a broken
 * whole-screen zoom even when the focus box is correct. */
function pw(keys: CameraKey[], f: keyof Omit<CameraKey, "t">, T = "t"): string {
  if (!keys.length) return "1";
  const v = (k: CameraKey) => k[f].toFixed(4);
  let expr = v(keys[keys.length - 1]);
  for (let i = keys.length - 1; i >= 1; i--) {
    const a = keys[i - 1], b = keys[i];
    const d = b.t - a.t;
    const p = `((${T}-${a.t.toFixed(3)})/${d.toFixed(3)})`;
    const seg = d > 0.001 ? `(${v(a)}+(${v(b)}-${v(a)})*${p}*${p}*(3-2*${p}))` : v(b);
    expr = `if(lt(${T},${b.t.toFixed(3)}),${seg},${expr})`;
  }
  return `if(lt(${T},${keys[0].t.toFixed(3)}),${v(keys[0])},${expr})`;
}

/** Camera choreography in output time.
 *
 * One focused scene is a bounded shot: ease in, hold, ease back to wide.
 * Adjacent focused scenes are one shot and reframe directly, rather than
 * pumping wide between every click. A static scene (or the end of the take)
 * closes the shot, so a missing hold can never leave the video locked zoomed.
 */
export function cameraKeys(take: Take, W: number, H: number): { keys: CameraKey[]; count: number } {
  const sc = scenes(take);
  const centre: CameraKey = { t: 0, z: 1, cx: W / 2, cy: H / 2 };
  const DEFAULT_EASE = 0.65;
  const DEFAULT_HOLD = 1.2;
  const MARGIN = 28;
  const sourceScenes = sc
    .map((s, index) => ({ s, rawNext: sc[index + 1]?.start ?? take.duration }))
    // A scene whose whole interval was removed by the head trim cannot affect
    // the retained camera. Keeping it would clamp both ends to t=0 and leave
    // its zoom target as the final key forever.
    .filter(({ rawNext }) => rawNext > take.trimBefore);
  const prepared = sourceScenes.map(({ s, rawNext }) => {
    const t0 = Math.max(0, s.start - take.trimBefore);
    const next = Math.max(t0, rawNext - take.trimBefore);
    if (!s.camera) return { s, t0, next, target: undefined as CameraKey | undefined, requestedEase: DEFAULT_EASE };
    const fit = Math.min(s.camera.zoom, W / (s.camera.box.width + 2 * MARGIN), H / (s.camera.box.height + 2 * MARGIN));
    if (fit < 1.08) {
      s.camera = undefined; // focus already fills the frame; moving would only distract
      return { s, t0, next, target: undefined as CameraKey | undefined, requestedEase: DEFAULT_EASE };
    }
    const z = Math.round(fit * 100) / 100;
    const b = s.camera.box;
    const halfW = W / (2 * z), halfH = H / (2 * z);
    const cx = Math.min(Math.max(b.x + b.width / 2, halfW), W - halfW);
    const cy = Math.min(Math.max(b.y + b.height / 2, halfH), H - halfH);
    s.camera.zoom = z; // proof log records the crop-safe zoom actually used
    return {
      s,
      t0,
      next,
      target: { t: t0, z, cx, cy },
      requestedEase: Math.max(0.2, (s.camera.easeMs ?? DEFAULT_EASE * 1000) / 1000),
    };
  });

  const keys: CameraKey[] = [];
  let cur = { ...centre };
  let count = 0;
  for (const [index, item] of prepared.entries()) {
    if (!item.target || !item.s.camera) continue;
    count++;
    const span = Math.max(0, item.next - item.t0);
    // Preserve a complete in/out gesture in a short scene instead of clipping
    // the release at the next marker. Normal scenes keep the requested ease.
    const ease = Math.min(item.requestedEase, Math.max(0.05, span / 3));
    const target = { ...item.target, t: item.t0 + ease };
    keys.push({ ...cur, t: item.t0 }, target);

    const nextIsFocused = !!prepared[index + 1]?.target;
    if (!nextIsFocused) {
      const wantedHold = (item.s.camera.holdMs ?? DEFAULT_HOLD * 1000) / 1000;
      const hold = Math.min(wantedHold, Math.max(0, item.next - target.t - ease));
      const holdUntil = target.t + hold;
      const releaseUntil = Math.min(item.next, holdUntil + ease);
      if (holdUntil > target.t + 0.001) keys.push({ ...target, t: holdUntil });
      if (releaseUntil > holdUntil + 0.001) keys.push({ ...centre, t: releaseUntil });
      cur = { ...centre, t: releaseUntil };
    } else {
      cur = { ...target };
    }
  }
  return { keys, count };
}

/** Build the ffmpeg zoompan filter from the bounded camera choreography. */
function cameraFilter(take: Take, W: number, H: number, fps: number): { filter: string; count: number } {
  const { keys, count } = cameraKeys(take, W, H);
  if (!count) return { filter: "", count: 0 };
  const T = `(in/${fps})`;
  const z = pw(keys, "z", T);
  const cx = pw(keys, "cx", T);
  const cy = pw(keys, "cy", T);
  const x = `max(0,min(iw-iw/(${z}),(${cx})-iw/(2*(${z}))))`;
  const y = `max(0,min(ih-ih/(${z}),(${cy})-ih/(2*(${z}))))`;
  return { filter: `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${fps}`, count };
}

// --- joining segments --------------------------------------------------------

/** Build the filter graph that joins intro, body and outro.
 *
 * `cut` stays a plain concat — byte-identical to what Retake produced before
 * transitions existed. Anything else chains `xfade`, whose offset must be
 * measured in the timeline built SO FAR, not in the source segment: each
 * transition overlaps the two clips, so every later offset shifts earlier by
 * the duration already consumed. Getting that wrong is how a dissolve ends up
 * cutting off the last half-second of a card.
 */
export function joinGraph(segs: string[], tr: { style: string; ms: number }, fps: number): string {
  const labels = segs.map((_, i) => `[${i}:v]`);
  if (tr.style === "cut" || segs.length < 2) {
    return `${labels.join("")}concat=n=${segs.length}:v=1:a=0[out]`;
  }
  const d = tr.ms / 1000;
  const durations = segs.map((f) => probe(f).duration);
  const chain: string[] = [];
  let prev = labels[0];
  let elapsed = durations[0];
  for (let i = 1; i < segs.length; i++) {
    const out = i === segs.length - 1 ? "[out]" : `[x${i}]`;
    // Offset is where the overlap starts on the timeline assembled so far.
    const offset = Math.max(0, elapsed - d);
    chain.push(`${prev}${labels[i]}xfade=transition=${tr.style}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}${out}`);
    // The overlap is shared, so the timeline grows by less than the new clip.
    elapsed = offset + d + durations[i] - d;
    prev = out;
  }
  return chain.join(";");
}

/** Join already-rendered outputs, never replaying a browser or synthesizing a voice.
 * The first video defines the canvas and frame rate; other clips fit, not crop.
 * Intermediates make timestamps, pixel format and time base identical for xfade.
 */
export function stitch(inputs: string[], output: string, options: {
  transition?: { style?: string; ms?: number };
  /** Preserve the first audio stream from each source; false explicitly mutes. */
  audio?: boolean;
  log?: (line: string) => void;
} = {}): string {
  const transition = Manifest.shape.transition.parse(options.transition);
  if (inputs.length < 2) throw new Error("stitch needs at least two inputs");
  const target = path.resolve(output);
  if (path.extname(target).toLowerCase() !== ".mp4") throw new Error("stitch output must be an .mp4 file");
  if (fs.existsSync(target)) throw new Error(`stitch output already exists: ${target} — choose a new file`);
  const files = inputs.map((input) => {
    let file = path.resolve(input);
    if (!fs.existsSync(file)) throw new Error(`stitch: missing input ${file}`);
    if (fs.statSync(file).isDirectory()) file = path.join(file, "demo.mp4");
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`stitch: missing input ${file}`);
    return file;
  });
  const info = files.map((file) => {
    const p = probe(file);
    if (!(p.width > 0 && p.height > 0 && p.fps > 0 && p.duration > 0)) throw new Error(`stitch: no usable video in ${file}`);
    return p;
  });
  const first = info[0];
  if (first.width % 2 || first.height % 2) throw new Error("stitch needs an even-sized first canvas for H.264; choose another first clip or re-render it");
  // Leave at least a frame outside each overlap. A middle clip participates
  // in two joins; accepting only one overlap silently eats that whole clip.
  const checkLength = (duration: number, i: number) => {
    const overlap = transition.style === "cut" ? 0 : transition.ms / 1000 * (i > 0 && i < files.length - 1 ? 2 : 1);
    if (duration < overlap + 1 / first.fps - 0.001) throw new Error(`stitch: too short: ${files[i]} (${duration}s) — needs more than ${overlap}s for the transitions; shorten --transition-ms or use cut`);
  };
  info.forEach((p, i) => checkLength(p.duration, i));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = fs.mkdtempSync(path.join(path.dirname(target), ".retake-stitch-"));
  try {
    const segments = files.map((file, i) => {
      const segment = path.join(temp, `${i}.mp4`);
      ff(["-i", file, "-map", "0:v:0", "-an", "-vf",
        // The first clip fixes the encoded canvas, not its pixel shape.
        // Fit every source (including the first) using display aspect (dar)
        // before making pixels square; force_original_aspect_ratio fits iw/ih.
        `setpts=PTS-STARTPTS,fps=${first.fps},scale=w='max(2,trunc(min(${first.width},${first.height}*dar)/2)*2)':h='max(2,trunc(min(${first.height},${first.width}/dar)/2)*2)',setsar=1,pad=${first.width}:${first.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
        "-c:v", "libx264", "-preset", "fast", "-crf", "14", segment], options.log);
      return segment;
    });
    const durations = segments.map((file, i) => {
      const duration = probe(file).duration;
      checkLength(duration, i); // fps conversion may round a marginal clip down
      return duration;
    });
    // Read the first decoded video timestamp in the source clock. Subtract
    // that SAME origin from audio, not its own STARTPTS: late audio needs
    // leading silence and audio preceding the first picture must be trimmed.
    // showinfo uses ffmpeg itself, so stitch does not require ffprobe.
    const timing = options.audio === false ? [] : files.map((file) => {
      const p = spawnSync(ffmpegBin(), ["-hide_banner", "-copyts", "-i", file, "-map", "0:v:0", "-an",
        "-vf", "showinfo", "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" });
      const start = /\bn:\s*0\s+pts:\s*\S+\s+pts_time:([-\d.e+]+)/.exec(p.stderr);
      if (p.status !== 0 || !start || !Number.isFinite(Number(start[1]))) throw new Error(`stitch: cannot read video timestamp in ${file}`);
      return { origin: Number(start[1]), audio: /Audio:/.test(p.stderr) };
    });
    const hasAudio = files.map((_, i) => timing[i]?.audio ?? false);
    const audio = hasAudio.some(Boolean);
    options.log?.(`stitch: ${files.length} clips · ${first.width}×${first.height} @ ${first.fps}fps · ${transition.style} · audio ${audio ? "preserved (first stream per clip; silence where absent)" : options.audio === false ? "explicitly muted" : "none"}`);
    const graph = [joinGraph(segments, transition, first.fps)];
    const audioInputs: string[] = [];
    if (audio) {
      let index = segments.length;
      durations.forEach((duration, i) => {
        const source = hasAudio[i] ? `[${index++}:a:0]` : "anullsrc=r=48000:cl=stereo,";
        if (hasAudio[i]) audioInputs.push("-i", files[i]);
        graph.push(`${source}${hasAudio[i] ? `asetpts=PTS-(${timing[i].origin})/TB,` : ""}aresample=48000:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${duration}[a${i}]`);
      });
      if (transition.style === "cut") {
        graph.push(`${files.map((_, i) => `[a${i}]`).join("")}concat=n=${files.length}:v=0:a=1[aout]`);
      } else {
        let previous = "[a0]";
        for (let i = 1; i < files.length; i++) {
          const next = i === files.length - 1 ? "[aout]" : `[ax${i}]`;
          graph.push(`${previous}[a${i}]acrossfade=d=${transition.ms / 1000}:c1=tri:c2=tri${next}`);
          previous = next;
        }
      }
    }
    const result = path.join(temp, "joined.mp4");
    ff(["-copyts", ...segments.flatMap((file) => ["-i", file]), ...audioInputs, "-filter_complex", graph.join(";"),
      "-map", "[out]", ...(audio ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "160k"] : ["-an"]),
      "-c:v", "libx264", "-preset", "fast", "-crf", "17", "-pix_fmt", "yuv420p", "-movflags", "+faststart", result], options.log);
    fs.copyFileSync(result, target, fs.constants.COPYFILE_EXCL);
    return target;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
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
  const browser = await launchChromium();
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
    const segs = planIdle(take, keep, pausesOf(m));
    if (segs.length) {
      const paced = path.join(outDir, ".paced.mp4");
      ff([...warpFilterArgs(take.video, segs, take.duration, paced).slice(0, -1), "-r", String(resolve(m).fps), "-c:v", "libx264", "-crf", "14", "-preset", "veryfast", "-pix_fmt", "yuv420p", paced], log);
      idleLines = describeIdle(take, segs);
      for (const l of idleLines) log?.(`idle: ${l}`);
      take = { ...warpTake(take, segs), video: paced };
    }
  }
  // Narration holds: each narrated scene lasts as long as its paragraph. The
  // performance is synthesized here (cached — the voice pass reuses it) so the
  // picture can wait for the words instead of the words being cut short.
  if (m.voiceover && m.voiceover !== true && m.voiceover.script && m.voiceover.align === "scenes" && take.video) {
    const vo = m.voiceover;
    const paragraphs = vo.script!.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const probe = path.join(outDir, ".vo-plan.mp3");
    const cues = synthesizeWithCues(paragraphs.join("\n\n"), vo.voice, probe, vo.ratePercent);
    const spans = cuesPerParagraph(paragraphs, cues);
    fs.rmSync(probe, { force: true });
    const wins = narrationWindows(take).map((w) => ({ from: w.from + take.trimBefore, to: w.to + take.trimBefore }));
    const holds = planHolds(wins, spans.map((sp) => sp.end - sp.start), 0.1);
    if (holds.length) {
      const held = path.join(outDir, ".held.mp4");
      ff([...holdFilterArgs(take.video, holds, take.duration, held).slice(0, -1), "-r", String(resolve(m).fps), "-c:v", "libx264", "-crf", "14", "-preset", "veryfast", "-pix_fmt", "yuv420p", held], log);
      for (const h of holds) log?.(`hold: the picture rests ${h.seconds.toFixed(1)}s at ${(h.at - take.trimBefore).toFixed(1)}s so the line can finish`);
      take = { ...holdTake(take, holds), video: held };
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
  // Full bleed has no band to put words in: they sit over the picture, low,
  // on a dark box, like subtitles.
  if (q.captions && layout === "none") {
    capY = "h-th-h*0.07";
    capColor = q.captions.color ?? "white";
    capBox = ":box=1:boxcolor=black@0.55:boxborderw=18";
  }
  if (q.captions) {
    const maxChars = maxCharsFor(W, capSize);
    for (const w of spokenCaptions(m, take, outDir) ?? captionWindows(take)) {
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
  } else if (q.master && !o.noMaster) {
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
    if (m.intro) { const c = await renderCard(ffmpegBin(), outDir, "intro", m.intro, dims.width, dims.height, fps, q.theme, m.card); segs.push(c.mp4); cover = c.cover; }
    segs.push(mp4);
    if (m.outro) segs.push((await renderCard(ffmpegBin(), outDir, "outro", m.outro, dims.width, dims.height, fps, q.theme, m.card)).mp4);
    if (segs.length > 1) {
      const joined = path.join(outDir, ".joined.mp4");
      const tr = m.transition ?? { style: "cut" as const, ms: 400 };
      ff([...segs.flatMap((f) => ["-i", f]), "-filter_complex", joinGraph(segs, tr, fps), "-map", "[out]", "-r", String(fps), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", ...x264(q.crf, "medium"), joined], log);
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
      const spec = m.voiceover === true ? { voice: DEFAULT_VOICE, gainDb: 0, ratePercent: 0, script: undefined as string | undefined, fragments: true, align: "start" as const } : m.voiceover;
      if (spec.script && spec.align === "scenes") {
        // One performance, placed line by line. Read once so the voice sounds
        // like a person; cut at the sentence timings so each line lands when
        // its action happens. Over-long lines are reported, never sped up.
        const paragraphs = spec.script.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
        const wins = narrationWindows(take);
        const clip = path.join(outDir, ".vo-0.mp3");
        const cues = synthesizeWithCues(paragraphs.join("\n\n"), spec.voice, clip, spec.ratePercent);
        const spans = cuesPerParagraph(paragraphs, cues);
        const n = Math.min(spans.length, wins.length);
        if (paragraphs.length !== wins.length) log?.(`voiceover: ${paragraphs.length} paragraphs for ${wins.length} narrated scenes — each scene gets one paragraph, in order; the extra ${paragraphs.length > wins.length ? "paragraphs are dropped" : "scenes stay silent"}`);
        // Cut in the middle of the pause between lines — never at the sentence
        // timing itself, which sits against the next word — and fade each line
        // in and out so it arrives and leaves like speech, not like a switch.
        const bounds = narrationBounds(clip, spans, n);
        const FADE_IN = 0.03, FADE_OUT = 0.12;
        const LEAD = NARRATION_LEAD;
        for (let k = 0; k < n; k++) {
          const a = bounds[k], b = bounds[k + 1], len = b - a;
          const at = wins[k].from + introShift + LEAD;
          const limit = (k + 1 < wins.length ? wins[k + 1].from + introShift : dur - 0.5) - 0.2;
          const over = at + len - limit;
          // Under 50ms is inside the breathing room the limit already keeps.
          if (over >= 0.05) log?.(`voiceover: line ${k + 1} (“${paragraphs[k].slice(0, 40)}…”) runs ${over.toFixed(2)}s into ${k + 1 < wins.length ? "the next scene" : "the closing card"} — shorten the line or hold the scene longer. Retake will not speed a voice up.`);
          audioIn.push("-i", clip);
          chains.push(`[${idx}:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${FADE_IN},afade=t=out:st=${Math.max(0, len - FADE_OUT).toFixed(3)}:d=${FADE_OUT},volume=${spec.gainDb}dB,adelay=${Math.round(at * 1000)}:all=1[vo${k}]`);
          mixIns.push(`[vo${k}]`);
          idx++;
        }
      } else if (spec.script) {
        // One script, one performance: prosody carries across the whole
        // video the way a person reads. Starts after the title card.
        const clip = path.join(outDir, ".vo-0.mp3");
        synthesize(spec.script, spec.voice, clip, spec.ratePercent);
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
          synthesize(w.text, spec.voice, clip, spec.ratePercent);
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
    // A narration can finish before the picture. Pad the mixed track to the
    // exact video duration before `-shortest`; otherwise ffmpeg stops the
    // deliverable when the voice stops and silently cuts off the final scene.
    const graph = `${chains.join(";")};${mixIns.join("")}amix=inputs=${mixIns.length}:duration=longest:normalize=0,apad,atrim=0:${dur.toFixed(2)}[a]`;
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
  // How much later the recording starts once the video opens on its poster.
  let openShift = 0;

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
    const end = take.duration - take.trimBefore;
    // A scene's last moment, like its -end still: one second in, the click
    // that starts it has not landed — a poster for the control room showed
    // the guide page it was leaving.
    const settled = (pick: TimelineEntry | undefined) => {
      if (!pick) return Math.max(0, end - 0.5);
      const i = sc.indexOf(pick);
      const from = pick.start - take.trimBefore;
      const next = sc[i + 1] ? sc[i + 1].start - take.trimBefore : end;
      return Math.min(Math.max(from + 0.4, next - 0.6), Math.max(0, end - 0.2));
    };
    let at: number;
    if (typeof m.outputs.thumbnail === "object") {
      const want = m.outputs.thumbnail.scene;
      const s = sc.find((x) => x.label === want);
      // On a take that stopped early the chosen scene may never have happened;
      // fall back to the last scene that did rather than failing the render.
      const pick = s ?? sc.at(-1);
      at = settled(pick);
      if (!s) log?.(`thumbnail: scene "${want}" never happened — using ${pick ? `"${pick.label}"` : "the end"}`);
    } else {
      at = settled(sc.at(-1));
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
    if (m.outputs.cover && thumbnail) {
      // The designed poster takes the thumbnail's place; the bare frame stays.
      const d = probe(mp4);
      const frame = path.join(outDir, "frame.png");
      // The picture under the words: from the recording before captions are
      // burned in — a poster never carries a subtitle. Same moment, same size.
      fs.copyFileSync(thumbnail, frame);
      if (q.captions && take.video && fs.existsSync(take.video)) {
        try { ff(["-ss", (seek - cardShift + take.trimBefore).toFixed(2), "-i", take.video, "-frames:v", "1", "-vf", `scale=${d.width}:${d.height}:force_original_aspect_ratio=increase,crop=${d.width}:${d.height}`, "-y", frame], log); }
        catch { fs.copyFileSync(thumbnail, frame); }
      }
      await renderPoster(frame, thumbnail, m.outputs.cover, d.width, d.height, {
        matte: m.card?.ink ?? q.theme.background, ground: m.card?.background ?? q.theme.ink,
        logo: m.card?.logo ? path.resolve(m.card.logo) : undefined, font: m.card?.font ? path.resolve(m.card.font) : undefined,
      });
      mark("poster");
      // The video opens on its poster, then fades into the recording; the
      // voice and captions move with the recording. Where a video is posted,
      // its first frame is its thumbnail.
      if (m.outputs.cover.open > 0) {
        const T = m.outputs.cover.open / 1000, X = Math.min(0.4, T / 2);
        const fpsOut = d.fps || resolve(m).fps;
        const opened = path.join(outDir, ".opened.mp4");
        const hasAudio = probeHasAudio(mp4);
        ff([
          "-loop", "1", "-framerate", String(fpsOut), "-t", T.toFixed(3), "-i", thumbnail, "-i", mp4,
          "-filter_complex",
          `[0:v]scale=${d.width}:${d.height},setsar=1,format=yuv420p,fps=${fpsOut}[p];[1:v]fps=${fpsOut},setsar=1,format=yuv420p[b];[p][b]xfade=transition=fade:duration=${X.toFixed(3)}:offset=${(T - X).toFixed(3)}[v]` +
            (hasAudio ? `;[1:a]adelay=${Math.round((T - X) * 1000)}:all=1[a]` : ""),
          "-map", "[v]", ...(hasAudio ? ["-map", "[a]", "-c:a", "aac", "-b:a", "192k"] : ["-an"]),
          "-c:v", "libx264", "-crf", "17", "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", opened,
        ], log);
        fs.renameSync(opened, mp4);
        openShift = T - X;
        log?.(`poster: the video opens on it for ${T.toFixed(1)}s`);
      }
    }
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
      shots.push({ at: at + cardShift + openShift, file });
      stills.push(file);
      // And the scene's last moment: the caption names what the scene
      // achieves, and that is usually on screen at the end, not the middle.
      const atEnd = Math.min(Math.max(from + 0.4, next - 0.6), Math.max(0, end - 0.2));
      if (atEnd - at > 0.5) { const fe = path.join(dir, `${base}-end.png`); shots.push({ at: atEnd + cardShift + openShift, file: fe }); stills.push(fe); }
    }
    if (shots.length) {
      // Each still is its own ffmpeg with an INPUT-side seek: `-ss` before
      // `-i` jumps by keyframe, while one batched process with `-ss` after
      // `-i` decodes sequentially to every timestamp and is far slower (it
      // turned 3s of stills into 18s — measured, then reverted). The launches
      // are independent, so they run at once instead of in a queue.
      // Bounded. `Promise.all` over the shots launched one ffmpeg per scene
      // all at once: a sixty-five scene demo started sixty-five decoders on a
      // laptop that was already recording something. Each launch is cheap and
      // independent, so a small pool keeps the parallelism that made this fast
      // without letting the count follow the manifest.
      const bin = ffmpegBin();
      const grab = (s: { at: number; file: string }) => new Promise<void>((done) => {
        execFile(bin, ["-hide_banner", "-loglevel", "error", "-y", "-ss", s.at.toFixed(2), "-i", mp4, "-frames:v", "1", s.file], () => done());
      });
      await inBatches(shots, STILL_WORKERS, grab);
      stills = stills.filter((f) => fs.existsSync(f));
    }
    if (sc.length) mark(`stills ×${sc.length}`);
  }
  if (!master) fs.rmSync(path.join(outDir, "master.mp4"), { force: true });

  // The poster is also the file's own cover image — what Finder, QuickTime
  // and most players show before anyone presses play. Last, so nothing above
  // ever reads the picture instead of the video.
  if (m.outputs.cover && thumbnail && fs.existsSync(thumbnail) && fs.existsSync(mp4)) {
    const covered = path.join(outDir, ".covered.mp4");
    try {
      ff(["-i", mp4, "-i", thumbnail, "-map", "0", "-map", "1", "-c", "copy", "-c:v:1", "mjpeg", "-disposition:v:1", "attached_pic", "-movflags", "+faststart", covered], log);
      fs.renameSync(covered, mp4);
      mark("cover image");
    } catch (e) {
      fs.rmSync(covered, { force: true });
      log?.(`cover image: not embedded (${(e as Error).message.split("\n")[0]}) — the video itself is fine`);
    }
  }

  const p = probe(mp4);
  const facts: Facts = {
    width: p.width, height: p.height, fps: p.fps || fps, duration: p.duration,
    sizes: Object.fromEntries([master, mp4, gif, thumbnail].filter((f): f is string => !!f && fs.existsSync(f)).map((f) => [path.basename(f), fs.statSync(f).size])),
    gifTool, layout, cameraScenes: cam.count, encoder: q.encoder, timings: t.marks, renderHash: hash, preset: q.name, master: !!master,
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
export function contactSheetFile(mp4: string, out: string, everySec = 2, width = 420, log?: (l: string) => void): string {
  if (!fs.existsSync(mp4)) throw new Error(`video does not exist: ${mp4}`);
  const dur = probe(mp4).duration;
  const last = Math.max(0, dur - 0.05);
  const times: number[] = [];
  for (let time = 0; time < last - 0.1; time += everySec) times.push(time);
  if (!times.length || last - times[times.length - 1] > 0.1) times.push(last);
  const cells = times.length;
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(cells))));
  const rows = Math.ceil(cells / cols);
  const fontFile = DEFAULT_FONTS.find((f) => fs.existsSync(f));
  const font = fontFile ? `fontfile='${fontFile}':` : "";
  const select = times.map((time) => `between(t\\,${time.toFixed(3)}\\,${Math.min(dur, time + 0.06).toFixed(3)})`).join("+");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Select explicit source timestamps, including the final frame. The timestamp
  // overlay runs before tiling and therefore preserves the source clock.
  const stamp = `drawtext=${font}text='%{pts\\:hms}':x=8:y=8:fontsize=${Math.round(width / 20)}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=5`;
  const sheet = (withTime: boolean) => [
    `select='${select}'`,
    `scale=${width}:-2`,
    ...(withTime ? [stamp] : []),
    `tile=${cols}x${rows}:margin=8:padding=6:color=#e6e9e2`,
  ].join(",");
  // Some ffmpeg builds (the static Linux one among them) have no drawtext.
  // A sheet without timestamps still shows every frame, ending included.
  try { ff(["-i", mp4, "-vf", sheet(true), "-frames:v", "1", out], log); }
  catch (e) {
    if (!/Filter not found|No such filter|drawtext/i.test(String((e as Error).message))) throw e;
    log?.("contact: this ffmpeg has no drawtext — the sheet carries no timestamps");
    ff(["-i", mp4, "-vf", sheet(false), "-frames:v", "1", out], log);
  }
  if (!fs.existsSync(out)) throw new Error("ffmpeg produced no contact sheet");
  log?.(`contact: ${cells} explicit frames through ${last.toFixed(2)}s, ${cols}×${rows} → ${path.relative(process.cwd(), out)}`);
  return out;
}

export function contactSheet(outDir: string, everySec = 2, width = 420, log?: (l: string) => void): string {
  const mp4 = path.join(outDir, "demo.mp4");
  if (!fs.existsSync(mp4)) throw new Error(`no demo.mp4 in ${outDir} — render it first`);
  return contactSheetFile(mp4, path.join(outDir, "contact.png"), everySec, width, log);
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
/**
 * How many frame grabs run at once.
 *
 * Measured on a real 65-scene demo, on an eight-core machine:
 *
 *     65 at once (what it did before)  13.1s
 *     16                                6.9s
 *      8                                5.5s
 *      4                                6.1s
 *      2                                9.8s
 *
 * So the unbounded version was not merely reckless, it was two and a half
 * times SLOWER — sixty-five decoders fighting over one file and eight cores.
 * The floor is at the core count, which is where this sits.
 */
export const STILL_WORKERS = 8;

/** Run `fn` over everything, at most `limit` at a time, in order. */
export async function inBatches<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }));
}

/** Ad, analytics and tracking hosts. Their requests fail all the time on
    public sites (a gd.games take logged SSL failures from its ad partners) and
    never put anything the viewer sees on screen. */
const BACKGROUND_HOSTS = /(^|\.)(doubleclick\.net|googlesyndication\.com|googleadservices\.com|google-analytics\.com|googletagmanager\.com|adnxs\.com|criteo\.(com|net)|rubiconproject\.com|pubmatic\.com|indexww\.com|4dex\.io|the-ozone-project\.com|amazon-adsystem\.com|adsrvr\.org|casalemedia\.com|openx\.net|taboola\.com|outbrain\.com|scorecardresearch\.com|quantserve\.com|hotjar\.com|segment\.(io|com)|facebook\.net|clarity\.ms|sentry\.io|id5-sync\.com|lijit\.com|sharethrough\.com|smartadserver\.com|teads\.tv|yieldmo\.com|bidswitch\.net|vntsm\.io|venatusmedia\.com)$/i;
/** Paths that only report: analytics, beacons, tracking pixels. */
const BACKGROUND_PATHS = /\/(analytics|collect|beacon|pixel|track|telemetry|usync|user_sync)(\/|\?|$|\.)/i;

export function isNonVisualResourceError(text: string, url?: string): boolean {
  if (/^Failed to load resource:\s+net::ERR_(?:CONNECTION_CLOSED|CONNECTION_RESET|ABORTED|BLOCKED_BY_CLIENT)\b/.test(text.trim())) return true;
  if (url && /^Failed to load resource:/.test(text.trim())) {
    try { const u = new URL(url); return BACKGROUND_HOSTS.test(u.hostname) || BACKGROUND_PATHS.test(u.pathname); } catch { return false; }
  }
  return false;
}

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
  // Whole-video judgements (is it long enough, does it have every scene) do
  // not apply to a deliberate fragment.
  const fragment = /\((?:from|until)\)/.test(take.partial ?? "");
  if (fragment) lines.push(`—     duration: ${p.duration.toFixed(1)}s (not judged — this is a fragment)`);
  else say(p.duration >= 5 && p.duration <= longest, `duration: ${p.duration.toFixed(1)}s`);
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
    ? planIdle(take, m.compressIdle === true ? 1.5 : m.compressIdle.keepSeconds, pausesOf(m))
    : [];
  const shownTake = idleSegs.length ? warpTake(take, idleSegs) : take;
  const stalled = (shownTake.timeline || [])
    .filter((t) => t.action !== "wait" && t.action !== "scene" && t.action !== "stub")
    // A pause the manifest asked for is pacing, not a stall: a green-flag
    // click held for 14.8s while an animation played was failed as "frozen".
    .map((t) => ({ ...t, took: t.end - t.start - ((m?.steps[t.index] as { pauseAfter?: number } | undefined)?.pauseAfter ?? 0) / 1000 }))
    .filter((t) => t.took > PATIENCE)
    .sort((a, b) => b.took - a.took);
  // Did the app break, and was it still broken when the video stopped? A
  // take can pass every step and end on an error screen; one did, and only
  // frame-by-frame review found it. An error in the last stretch is the
  // shape that matters — earlier ones are usually recovered from.
  const errs = take.pageErrors ?? [];
  const actionableErrors = errs.filter((e) => !isNonVisualResourceError(e.text, e.url));
  const ignoredResourceErrors = errs.length - actionableErrors.length;
  if (actionableErrors.length) {
    const endsAt = take.duration;
    const late = actionableErrors.filter((e) => e.at >= Math.max(0, endsAt - 6));
    if (late.length) {
      say(false, `the app reported an error in the last seconds and the video ends on it: “${late[0].text.slice(0, 120)}” at ${late[0].at.toFixed(1)}s — watch the final frames before shipping this`);
    } else {
      lines.push(`—     the app reported ${actionableErrors.length} error${actionableErrors.length > 1 ? "s" : ""} during the take (earliest “${actionableErrors[0].text.slice(0, 80)}”), none in the last 6s`);
    }
  }
  if (ignoredResourceErrors) {
    lines.push(`—     ignored ${ignoredResourceErrors} non-visual browser resource error${ignoredResourceErrors > 1 ? "s" : ""}; final-frame review is still required`);
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
  // Ask what this RENDER did, not what the preset would have done: --no-master
  // is a deliberate choice, and failing a take for honouring it made the flag
  // unusable on the presets it helps most.
  let madeMaster: boolean | undefined;
  try { madeMaster = (JSON.parse(fs.readFileSync(path.join(outDir, "facts.json"), "utf8")) as Facts).master; } catch { /* older take */ }
  const wantedMaster = madeMaster !== undefined ? madeMaster : !!q?.master;
  if (wantedMaster) say(fs.existsSync(master), `master.mp4 kept${fs.existsSync(master) ? ` (${mb(master)})` : ""}`);
  else lines.push(`—     master.mp4: not made for this render`);
  const gif = path.join(outDir, "demo.gif");
  if (fs.existsSync(gif)) say(true, `demo.gif: ${mb(gif)} (secondary)`); else lines.push(`—     demo.gif: not requested`);
  if (!m || m.outputs.thumbnail) say(fs.existsSync(path.join(outDir, "thumbnail.png")), "thumbnail exists");
  else lines.push("—     thumbnail: not requested");
  say(fs.existsSync(path.join(outDir, "proof-log.md")), "proof log exists");
  say(take.ok, take.ok ? "all steps passed" : "some steps failed");
  // A fragment recorded on purpose (--from / --until) is not a defect. Saying
  // FAIL about work that did exactly what was asked is how people learn to
  // skim past checks, including the ones that matter.
  // A brisk take has every step and none of the pacing. It is correct and it
  // is not shippable, and the only thing standing between it and being handed
  // over as final is this line. `check: pass` on one would be the tool lying
  // about the one thing it exists to be trusted on.
  if (take.brisk) say(false, "brisk — recorded without its pacing, for iterating. Record it again without --brisk before this goes anywhere.");
  if (fragment) say(true, `fragment — ${take.partial}`);
  else say(!take.partial, take.partial ? `partial: ${take.partial}` : "polished render (not fallback)");
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
    ...(take.contentWidth && take.layoutWidth && take.contentWidth !== take.layoutWidth
      ? [`- Page width: content had **${take.contentWidth} CSS px** of room (viewport ${take.layoutWidth} ÷ ${q.scale}× scale), while media queries read **${take.layoutWidth} px**. A responsive app therefore renders its DESKTOP layout squeezed into ${take.contentWidth}px rather than switching to mobile — if this take looks cramped, that is why, and \`scale: 1\` is the fix.`]
      : take.layoutWidth ? [`- Page laid out at: **${take.layoutWidth} CSS px** wide.`] : []),
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
