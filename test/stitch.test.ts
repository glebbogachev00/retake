import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ffmpegBin, probe, stitch } from "../src/render.js";

test("stitch preflights missing/short inputs and refuses overwrites before rendering", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-errors-"));
  try {
    const clip = fixture(dir, "clip.mp4", "red");
    const short = fixture(dir, "short.mp4", "blue", "160x90", 20, 0.6);
    const out = path.join(dir, "new", "out.mp4");
    assert.throws(() => stitch([clip], out), /at least two/i);
    assert.throws(() => stitch([clip, path.join(dir, "missing")], out), /missing input/i);
    const empty = path.join(dir, "empty"); fs.mkdirSync(empty);
    assert.throws(() => stitch([clip, empty], out), /missing input.*demo\.mp4/i);
    assert.throws(() => stitch([clip, short, clip], out, { transition: { style: "fade", ms: 400 } }), /too short.*short\.mp4/i);
    assert.throws(() => stitch([short, clip], out, { transition: { style: "fade", ms: 600 } }), /too short/i);
    assert.throws(() => stitch([clip, clip], out, { transition: { style: "bogus" } }));
    assert.throws(() => stitch([clip, clip], out, { transition: { ms: NaN } }));
    assert.throws(() => stitch([clip, clip], out.replace(".mp4", ".webm")), /\.mp4/i);
    const before = fs.readFileSync(clip);
    assert.throws(() => stitch([clip, clip], clip), /already exists/i);
    assert.deepEqual(fs.readFileSync(clip), before);
    assert.equal(fs.existsSync(path.dirname(out)), false, "preflight must not render or create output directories");
    const r = run([clip, short, clip, "--out", out, "--transition", "fade"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /too short/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stitch preserves audio around a silent clip, crossfades joins, and supports explicit mute", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-audio-"));
  try {
    const tone = fixture(dir, "tone.mp4", "red", "160x90", 20, 2, true);
    const silent = fixture(dir, "silent.mp4", "lime");
    for (const style of ["fade", "cut"]) {
      const out = path.join(dir, `${style}.mp4`);
      const r = run([tone, silent, tone, "-o", out, "--transition", style]);
      assert.equal(r.status, 0, r.stderr);
      const meta = spawnSync(ffmpegBin(), ["-i", out], { encoding: "utf8" }).stderr;
      assert.match(meta, /Audio: aac.*48000 Hz, stereo/);
      const expected = style === "cut" ? 6 : 5.2;
      assert.ok(Math.abs(probe(out).duration - expected) < 0.11);
      const rms = (at: number) => {
        const bytes = execFileSync(ffmpegBin(), ["-v", "error", "-ss", String(at), "-i", out, "-t", "0.15", "-vn", "-ac", "1", "-f", "f32le", "pipe:1"]);
        let sum = 0;
        for (let i = 0; i < bytes.length; i += 4) sum += bytes.readFloatLE(i) ** 2;
        return Math.sqrt(sum / (bytes.length / 4));
      };
      assert.ok(rms(0.6) > 0.02, "first source audio survives");
      assert.ok(rms(2.6) < 0.001, "missing audio becomes silence, not a shifted soundtrack");
      assert.ok(rms(expected - 0.6) > 0.02, "third source audio stays aligned");
      if (style === "fade") assert.ok(rms(1.9) < rms(1.5) * 0.5, "audio fades with the picture");
    }
    const muted = path.join(dir, "muted.mp4");
    const r = run([tone, silent, tone, "-o", muted, "--no-audio"]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(spawnSync(ffmpegBin(), ["-i", muted], { encoding: "utf8" }).stderr, /Audio:/);
    assert.equal(fs.readdirSync(dir).some((f) => f.startsWith(".retake-stitch-")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stitch refuses an odd first canvas instead of failing inside the encoder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-odd-"));
  try {
    const odd = path.join(dir, "odd.mp4");
    execFileSync(ffmpegBin(), ["-v", "error", "-f", "lavfi", "-i", "testsrc=s=161x91:r=20:d=1", "-c:v", "libx264", "-pix_fmt", "yuv444p", odd]);
    assert.throws(() => stitch([odd, odd], path.join(dir, "out.mp4")), /even.*canvas/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("all existing non-cut styles render three clips through joinGraph", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-styles-"));
  try {
    const files = ["red", "lime", "blue"].map((color) => fixture(dir, `${color}.mp4`, color));
    for (const style of ["fade", "dissolve", "wipeleft", "wiperight", "slideleft", "slideup", "circleopen"]) {
      const out = stitch(files, path.join(dir, `${style}.mp4`), { transition: { style, ms: 400 } });
      assert.ok(Math.abs(probe(out).duration - 5.2) < 0.11, style);
      assert.ok(pixel(out, 4.8)[2] > 220, `${style}: final clip survives`);
      execFileSync(ffmpegBin(), ["-v", "error", "-xerror", "-i", out, "-f", "null", "-"]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stitch rechecks VIDEO duration after normalization and cleans failed intermediates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-short-video-"));
  try {
    const normal = fixture(dir, "normal.mp4", "red");
    const short = path.join(dir, "long-audio.mp4");
    execFileSync(ffmpegBin(), ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=30:d=0.3", "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-c:a", "aac", short]);
    assert.ok(probe(short).duration >= 2, "container duration hides the short video");
    const out = path.join(dir, "out.mp4");
    assert.throws(() => stitch([normal, short, normal], out, { transition: { style: "fade" } }), /too short.*long-audio/i);
    assert.equal(fs.existsSync(out), false);
    assert.equal(fs.readdirSync(dir).some((f) => f.startsWith(".retake-stitch-")), false);
    const cut = stitch([normal, short, normal], out);
    assert.ok(Math.abs(probe(cut).duration - 4.3) < 0.12, "cut uses actual video length, audio is trimmed");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stitch keeps delayed audio silent until its original video-relative onset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-offset-"));
  try {
    const delayed = path.join(dir, "delayed.mp4");
    execFileSync(ffmpegBin(), ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=20:d=2",
      "-itsoffset", "0.5", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.5",
      "-c:v", "libx264", "-c:a", "aac", delayed]);
    const silent = fixture(dir, "silent.mp4", "blue");
    for (const style of ["cut", "fade"]) {
      const out = stitch([delayed, silent, delayed], path.join(dir, `${style}.mp4`), { transition: { style, ms: 400 } });
      const third = style === "cut" ? 4 : 3.2;
      for (const start of [0, third]) {
        assert.ok(audioRms(out, start + 0.1) < 0.001, `${style}: original leading silence at ${start}`);
        assert.ok(audioRms(out, start + 0.7) > 0.02, `${style}: original delayed tone at ${start}`);
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stitch trims early audio against video origin and removes only common timestamp offsets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-clock-"));
  try {
    const silent = fixture(dir, "silent.mp4", "blue");
    for (const early of [true, false]) {
      const source = path.join(dir, `${early}.mkv`);
      execFileSync(ffmpegBin(), ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=160x90:r=20:d=2",
        "-f", "lavfi", "-i", "aevalsrc=if(lt(t\\,0.3)+between(t\\,1\\,1.3)\\,0.1*sin(2*PI*440*t)\\,0):s=48000:d=2.5",
        "-vf", `setpts=PTS+${early ? 5.5 : 5}/TB`, "-af", "asetpts=PTS+5/TB",
        "-fps_mode", "passthrough", "-c:v", "libx264", "-c:a", "pcm_s16le", source]);
      const out = stitch([source, silent], path.join(dir, `${early}.mp4`));
      if (early) {
        assert.ok(audioRms(out, 0.1) < 0.001, "pre-video sound is trimmed, not replayed at video start");
        assert.ok(audioRms(out, 0.55) > 0.02, "later sound retains its video-relative time");
      } else {
        assert.ok(audioRms(out, 0.1) > 0.02, "shared five-second origin is removed from both streams");
        assert.ok(audioRms(out, 0.55) < 0.001, "shared clock does not change the sound pattern");
      }
      assert.ok(Math.abs(probe(out).duration - 4) < 0.11, "container start does not add five seconds to the join");
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("stitch fits display aspect rather than encoded aspect, including the first clip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-sar-"));
  try {
    const normal = fixture(dir, "normal.mp4", "red");
    const wide = path.join(dir, "wide.mp4"), narrow = path.join(dir, "narrow.mp4");
    for (const [file, sar] of [[wide, "2/1"], [narrow, "1/2"]]) {
      execFileSync(ffmpegBin(), ["-v", "error", "-f", "lavfi", "-i", "color=c=lime:s=160x90:r=20:d=2",
        "-vf", `setsar=${sar}`, "-c:v", "libx264", file]);
    }
    const joined = stitch([normal, wide, narrow], path.join(dir, "joined.mp4"));
    assert.ok(pixel(joined, 2.5)[1] > 220, "wide picture survives at the center");
    assert.ok(pixel(joined, 2.5, 80, 10).every((v) => v < 10), "SAR 2:1 is letterboxed, not squeezed");
    assert.ok(pixel(joined, 2.5, 80, 30)[1] > 220, "letterbox does not shrink more than needed");
    assert.ok(pixel(joined, 4.5, 10, 45).every((v) => v < 10), "SAR 1:2 is pillarboxed, not stretched");
    assert.ok(pixel(joined, 4.5, 50, 45)[1] > 220, "pillarbox does not shrink more than needed");
    const first = stitch([wide, normal], path.join(dir, "first-wide.mp4"));
    assert.deepEqual([probe(first).width, probe(first).height], [160, 90], "first encoded canvas stays fixed");
    assert.ok(pixel(first, 0.5, 80, 10).every((v) => v < 10), "anamorphic first clip also fits its display aspect inside the canvas");
    assert.ok(pixel(first, 0.5)[1] > 220);
    assert.match(spawnSync(ffmpegBin(), ["-i", first], { encoding: "utf8" }).stderr, /SAR 1:1/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function audioRms(file: string, at: number) {
  const bytes = execFileSync(ffmpegBin(), ["-v", "error", "-ss", String(at), "-i", file, "-t", "0.15", "-vn", "-ac", "1", "-f", "f32le", "pipe:1"]);
  assert.ok(bytes.length > 0, "audio samples decoded");
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum += bytes.readFloatLE(i) ** 2;
  return Math.sqrt(sum / (bytes.length / 4));
}

const cli = path.resolve("src/cli.ts");
function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, "stitch", ...args], { encoding: "utf8" });
}
function fixture(dir: string, name: string, color: string, size = "160x90", fps = 20, seconds = 2, audio = false) {
  const file = path.join(dir, name);
  execFileSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}:r=${fps}:d=${seconds}`,
    ...(audio ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${seconds}`, "-c:a", "aac"] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", file]);
  return file;
}
function pixel(file: string, time: number, x: number | string = "iw/2", y: number | string = "ih/2") {
  return [...execFileSync(ffmpegBin(), ["-v", "error", "-ss", String(time), "-i", file, "-vf", `crop=2:2:${x}:${y},scale=1:1`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])];
}

test("stitch CLI joins three existing outputs with both dissolves and normalizes video", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-stitch-"));
  try {
    const first = path.join(dir, "first"); fs.mkdirSync(first);
    fixture(first, "demo.mp4", "red");
    const green = fixture(dir, "green.mp4", "lime", "120x120", 25);
    const blue = fixture(dir, "blue.mp4", "blue", "240x120", 30);
    const out = path.join(dir, "joined.mp4");
    const r = run([first, green, blue, "--out", out, "--transition", "fade", "--transition-ms", "400"]);
    assert.equal(r.status, 0, r.stderr);
    const p = probe(out);
    assert.deepEqual([p.width, p.height, p.fps], [160, 90, 20]);
    assert.ok(Math.abs(p.duration - 5.2) < 0.11, JSON.stringify(p));
    for (const [at, channel] of [[0.5, 0], [2.5, 1], [4.8, 2]]) {
      assert.ok(pixel(out, at)[channel] > 220, `source at ${at}s survived`);
    }
    const a = pixel(out, 1.8), b = pixel(out, 3.4);
    assert.ok(a[0] > 60 && a[1] > 60, `first dissolve: ${a}`);
    assert.ok(b[1] > 60 && b[2] > 60, `second dissolve: ${b}`);
    const streams = spawnSync(ffmpegBin(), ["-i", out], { encoding: "utf8" }).stderr;
    assert.doesNotMatch(streams, /Audio:/, "silent inputs remain video-only");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
