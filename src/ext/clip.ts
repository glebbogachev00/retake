/**
 * A few seconds of a demo, cut out of the demo you already rendered.
 *
 * The whole point is not re-watching a seven-minute take to find out whether
 * one thing got fixed. So: no re-render, no second encode of anything. The
 * scene's own timestamp, `-ss` on the input side so ffmpeg seeks by keyframe
 * instead of decoding its way there, and a stream copy where it can.
 *
 * Clips are derived. They are written under `clips/` and can be deleted at any
 * time — nothing depends on one existing, and nothing here ever writes near
 * the take or the finished video.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import type { Take } from "../record.js";

const require = createRequire(import.meta.url);
let cached: string | null = null;
/** Located here rather than borrowed from the renderer: an extension that
    imports the renderer is not an extension. Cutting is not encoding. */
export function ffmpeg(): string {
  if (cached) return cached;
  try {
    const p = require("ffmpeg-static") as string;
    if (p && fs.existsSync(p)) return (cached = p);
  } catch { /* fall through to the one on PATH */ }
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return (cached = "ffmpeg");
}

/**
 * Where a scene sits in the FINISHED video.
 *
 * The same arithmetic the proof log has always printed for its shot list —
 * the raw time, less the setup that render trims off the front. Kept
 * identical on purpose: two different answers to "when does this scene
 * happen" is worse than one approximate one.
 */
export function sceneAt(take: Take, label: string): { start: number; hold: number } | null {
  const scenes = take.timeline.filter((t) => t.action === "scene");
  const i = scenes.findIndex((s) => (s as { label?: string }).label === label);
  if (i < 0) return null;
  const start = Math.max(0, scenes[i].start - take.trimBefore);
  // Up to the next scene, so a clip never runs past its own beat.
  const next = scenes[i + 1] ? Math.max(0, scenes[i + 1].start - take.trimBefore) : Number.POSITIVE_INFINITY;
  return { start, hold: Math.min(next - start, Number.POSITIVE_INFINITY) };
}

export type Clip = { file: string; start: number; seconds: number };

/**
 * Cut the seconds around a scene. `lead` is how much to include BEFORE the
 * scene mark, because the thing a scene is about usually just happened — the
 * click that produced the screen is a second or two earlier, and a clip that
 * opens on a static result tells you less than one that shows it arrive.
 */
export function clipFor(outDir: string, take: Take, label: string, opts: { seconds?: number; lead?: number } = {}): Clip | { error: string } {
  const video = ["demo.mp4", "master.mp4"].map((f) => path.join(outDir, f)).find((f) => fs.existsSync(f));
  if (!video) return { error: "no rendered video in this folder — clips come out of demo.mp4" };
  const at = sceneAt(take, label);
  if (!at) return { error: `no scene called "${label}" in this take` };

  const lead = opts.lead ?? 2;
  const seconds = Math.max(2, Math.min(opts.seconds ?? Math.max(6, Math.min(at.hold + lead, 12)), 20));
  const start = Math.max(0, at.start - lead);

  const dir = path.join(outDir, "clips");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}.mp4`);
  try {
    execFileSync(ffmpeg(), [
      "-y",
      // Input-side seek: keyframe jump, near-instant even on a long video.
      "-ss", start.toFixed(2),
      "-t", seconds.toFixed(2),
      "-i", video,
      // Re-encode rather than copy: a stream copy starts at the previous
      // keyframe, which on a 30fps demo can be two seconds before the beat
      // asked for. A six-second clip is cheap to encode and lands where it
      // was asked to.
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", "-an",
      file,
    ], { stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 });
  } catch (e) {
    // ffmpeg puts the real reason on stderr; the message alone is just the
    // command line. "moov atom not found" means the video is still being
    // written, which is worth saying rather than shrugging at.
    const err = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
    const why = /moov atom not found/.test(err)
      ? "that video is still being written — the render has not finished"
      : (err.split("\n").filter((l) => l && !/^\s|^ffmpeg version|^\s*lib|^\s*built|^\s*config/.test(l)).pop() ?? String((e as Error).message).split("\n")[0]).slice(0, 140);
    return { error: `could not cut the clip: ${why}` };
  }
  return { file, start, seconds };
}
