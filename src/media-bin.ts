import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
