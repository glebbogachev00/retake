import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let cachedBin: string | undefined;

/** Resolve the bundled media binary first, then fall back to PATH. */
export function ffmpegBin(): string {
  if (cachedBin) return cachedBin;
  if (process.env.FFMPEG_BIN) {
    execFileSync(process.env.FFMPEG_BIN, ["-version"], { stdio: "ignore" });
    return (cachedBin = process.env.FFMPEG_BIN);
  }
  try {
    const bundled = require("ffmpeg-static") as string;
    if (bundled && fs.existsSync(bundled)) return (cachedBin = bundled);
  } catch {
    // Fall through to the system binary.
  }
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return (cachedBin = "ffmpeg");
}
