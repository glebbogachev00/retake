/**
 * Voiceover: the captions read aloud. The captions ARE the script — each
 * scene's line is synthesized once and placed at the scene's start, so the
 * narration is honest to the take by construction.
 *
 * Engine: edge-tts (Microsoft's neural voices — free, network). Found as a
 * CLI (`edge-tts`, pipx/pip) or module (`python3 -m edge_tts`). Retake does
 * not bundle a voice engine; the error says how to install one.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const DEFAULT_VOICE = "en-US-JennyNeural";

function engine(): { cmd: string; args: string[] } {
  const home = process.env.HOME ?? "";
  for (const c of ["edge-tts", path.join(home, ".local", "bin", "edge-tts")]) {
    if (spawnSync(c, ["--help"], { stdio: "ignore" }).status === 0) return { cmd: c, args: [] };
  }
  if (spawnSync("python3", ["-m", "edge_tts", "--help"], { stdio: "ignore" }).status === 0) return { cmd: "python3", args: ["-m", "edge_tts"] };
  throw new Error("voiceover needs edge-tts — install it once with `pipx install edge-tts` (or `pip install edge-tts`), then re-render");
}

export function synthesize(text: string, voice: string, out: string): void {
  const e = engine();
  execFileSync(e.cmd, [...e.args, "--voice", voice, "--text", text, "--write-media", out], { stdio: "pipe", timeout: 60_000 });
  if (!fs.existsSync(out) || fs.statSync(out).size < 200) throw new Error(`voiceover: nothing came back for “${text.slice(0, 40)}…” — is the network up? (edge-tts is a network service)`);
}

export function audioSeconds(ffmpeg: string, file: string): number {
  const out = String(spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr);
  const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(out);
  if (!m) throw new Error(`could not read duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
