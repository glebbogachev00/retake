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
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

export const DEFAULT_VOICE = "en-US-JennyNeural";

/** Content-addressed speech cache. Narration text and voice are immutable
 * inputs, so generating the same line again is pure wasted network time. */
export function voiceCachePath(text: string, voice: string, ratePercent = 0): string {
  const root = process.env.RETAKE_TTS_CACHE || path.join(os.homedir(), ".cache", "retake-tts", "edge");
  const key = createHash("sha256").update(`${voice}\0${ratePercent}\0${text}`).digest("hex");
  return path.join(root, `${key}.mp3`);
}

function engine(): { cmd: string; args: string[] } {
  const home = process.env.HOME ?? "";
  for (const c of ["edge-tts", path.join(home, ".local", "bin", "edge-tts")]) {
    if (spawnSync(c, ["--help"], { stdio: "ignore" }).status === 0) return { cmd: c, args: [] };
  }
  if (spawnSync("python3", ["-m", "edge_tts", "--help"], { stdio: "ignore" }).status === 0) return { cmd: "python3", args: ["-m", "edge_tts"] };
  throw new Error("voiceover needs edge-tts — install it once with `pipx install edge-tts` (or `pip install edge-tts`), then re-render");
}

export function synthesize(text: string, voice: string, out: string, ratePercent = 0): void {
  const cached = voiceCachePath(text, voice, ratePercent);
  if (fs.existsSync(cached) && fs.statSync(cached).size >= 200) {
    fs.copyFileSync(cached, out);
    return;
  }
  const e = engine();
  const temp = `${out}.tmp-${process.pid}`;
  try {
    execFileSync(e.cmd, [...e.args, "--voice", voice, "--rate", `${ratePercent >= 0 ? "+" : ""}${ratePercent}%`, "--text", text, "--write-media", temp], { stdio: "pipe", timeout: 60_000 });
    if (!fs.existsSync(temp) || fs.statSync(temp).size < 200) throw new Error(`voiceover: nothing came back for “${text.slice(0, 40)}…” — is the network up? (edge-tts is a network service)`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(temp, cached);
    fs.renameSync(temp, out);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function audioSeconds(ffmpeg: string, file: string): number {
  const out = String(spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr);
  const m = /Duration:\s*(\d+):(\d+):(\d+\.?\d*)/.exec(out);
  if (!m) throw new Error(`could not read duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Where each sentence of one continuous performance starts and ends. */
export type Cue = { start: number; end: number; text: string };

function parseSrt(srt: string): Cue[] {
  const t = (s: string) => { const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s); return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : 0; };
  return srt.replace(/\r/g, "").split(/\n\s*\n/).map((block) => {
    const lines = block.trim().split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) return null;
    const [a, b] = lines[at].split("-->");
    return { start: t(a), end: t(b), text: lines.slice(at + 1).join(" ").trim() };
  }).filter((c): c is Cue => !!c && !!c.text);
}

/**
 * One performance, with the timing of every sentence in it.
 *
 * Reading each line separately resets the voice at every line — it sounds
 * like a list. Reading the whole script once sounds like a person, but then
 * nothing lands on its action. Both at once is what a north-star narration
 * does: synthesize once, keep where each sentence falls, and cut the
 * performance at those points. edge-tts writes the sentence timings itself.
 */
export function synthesizeWithCues(text: string, voice: string, out: string, ratePercent = 0): Cue[] {
  const cached = voiceCachePath(`cues\0${text}`, voice, ratePercent);
  const cachedSrt = cached.replace(/\.mp3$/, ".srt");
  if (fs.existsSync(cached) && fs.statSync(cached).size >= 200 && fs.existsSync(cachedSrt)) {
    fs.copyFileSync(cached, out);
    return parseSrt(fs.readFileSync(cachedSrt, "utf8"));
  }
  const e = engine();
  const temp = `${out}.tmp-${process.pid}`, srt = `${out}.srt`;
  try {
    execFileSync(e.cmd, [...e.args, "--voice", voice, "--rate", `${ratePercent >= 0 ? "+" : ""}${ratePercent}%`, "--text", text, "--write-media", temp, "--write-subtitles", srt], { stdio: "pipe", timeout: 120_000 });
    if (!fs.existsSync(temp) || fs.statSync(temp).size < 200) throw new Error("voiceover: nothing came back — is the network up? (edge-tts is a network service)");
    const cues = parseSrt(fs.readFileSync(srt, "utf8"));
    if (!cues.length) throw new Error("voiceover: the voice came back without sentence timings, so it cannot be placed on the scenes");
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(temp, cached);
    fs.copyFileSync(srt, cachedSrt);
    fs.renameSync(temp, out);
    return cues;
  } finally {
    fs.rmSync(temp, { force: true });
    fs.rmSync(srt, { force: true });
  }
}

/** Which consecutive sentences make up each paragraph of the script. */
/** The sentence cues each paragraph is made of, matched by word count. */
export function cueGroups(paragraphs: string[], cues: Cue[]): Cue[][] {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out: Cue[][] = [];
  let c = 0;
  for (const p of paragraphs) {
    const need = words(p).length;
    const group: Cue[] = [];
    let have = 0;
    while (c < cues.length && have < need) { have += words(cues[c].text).length; group.push(cues[c]); c++; }
    out.push(group);
  }
  return out;
}

export function cuesPerParagraph(paragraphs: string[], cues: Cue[]): { start: number; end: number }[] {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out: { start: number; end: number }[] = [];
  let c = 0;
  for (const p of paragraphs) {
    const need = words(p).length;
    if (c >= cues.length) break;
    const first = cues[c];
    let have = 0, last = first;
    while (c < cues.length && have < need) { have += words(cues[c].text).length; last = cues[c]; c++; }
    out.push({ start: first.start, end: last.end });
  }
  return out;
}

/** The quiet stretches in a recording, from ffmpeg's silencedetect. */
export function silences(ffmpeg: string, file: string, noiseDb = -40, minSeconds = 0.12): { start: number; end: number }[] {
  const err = String(spawnSync(ffmpeg, ["-hide_banner", "-i", file, "-af", `silencedetect=noise=${noiseDb}dB:d=${minSeconds}`, "-f", "null", "-"], { encoding: "utf8" }).stderr);
  const out: { start: number; end: number }[] = [];
  let open: number | null = null;
  for (const line of err.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line); if (s) open = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line); if (e && open !== null) { out.push({ start: open, end: Number(e[1]) }); open = null; }
  }
  return out;
}

/**
 * Where to cut one performance into its lines: in the MIDDLE of the pause
 * nearest each line boundary, never at the boundary itself.
 *
 * The sentence timings mark where the next sentence's text begins, which is
 * close to the next word, not inside the breath before it. Cutting there —
 * worse, cutting there plus a margin either side — opened each line on a
 * sliver of the previous word and ended it on the first syllable of the next.
 * Cutting in the middle of the pause leaves both words whole.
 */
export function cutPoints(boundaries: number[], quiet: { start: number; end: number }[], total: number): number[] {
  return boundaries.map((t) => {
    const near = quiet
      .filter((q) => q.end > t - 0.6 && q.start < t + 0.6)
      .sort((a, b) => Math.abs((a.start + a.end) / 2 - t) - Math.abs((b.start + b.end) / 2 - t))[0];
    return Math.min(total, Math.max(0, near ? (near.start + near.end) / 2 : t));
  });
}
