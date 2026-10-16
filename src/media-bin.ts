import fs from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { bundledFfmpeg } from "./self-repair.js";

let cachedBin: string | undefined;

/** Resolve the bundled media binary first, then fall back to PATH. */
export function ffmpegBin(): string {
  if (cachedBin) return cachedBin;
  if (process.env.FFMPEG_BIN) {
    execFileSync(process.env.FFMPEG_BIN, ["-version"], { stdio: "ignore" });
    return (cachedBin = process.env.FFMPEG_BIN);
  }
  // The bundled copy — fetched now if npm skipped its install script.
  const bundled = bundledFfmpeg();
  if (bundled) return (cachedBin = bundled);
  try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); }
  catch { throw new Error("Retake needs ffmpeg and could not get its own copy — install it once (`brew install ffmpeg` on a Mac), or reinstall with `npm install -g --allow-scripts=retake-demos,ffmpeg-static retake-demos`"); }
  return (cachedBin = "ffmpeg");
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
