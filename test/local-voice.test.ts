/** Local voices: Kokoro and Qwen3 (Aiden), spoken on this Mac. Onboarding
    offered both before Retake could produce either; these pin that it now
    can, says what it needs when it cannot, and reads demo words right. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { VOICES, voiceId } from "../src/routine.js";
import { LOCAL_VOICE, localEngine, localModelReady, synthesizeWithCues, voiceCachePath } from "../src/voice.js";
import { ffmpegBin } from "../src/media-bin.js";

const SCRIPT = path.resolve("scripts/local-voice.py");

test("the onboarding's local choices are real voice names", () => {
  assert.equal(voiceId("heart"), "kokoro:af_heart");
  assert.equal(voiceId("michael"), "kokoro:am_michael");
  assert.equal(voiceId("aiden"), "qwen:aiden");
  for (const v of ["kokoro:af_heart", "qwen:aiden", "kokoro:af_bella"]) assert.ok(LOCAL_VOICE.test(v), v);
  for (const v of ["en-US-AndrewNeural", "kokoro:", "qwen:Aiden", "edge:andrew"]) assert.ok(!LOCAL_VOICE.test(v), v);
  assert.ok(Object.values(VOICES).filter((v) => LOCAL_VOICE.test(v.id)).every((v) => /Local/.test(v.note)), "a local voice says so");
});

test("off Apple Silicon, a local voice says what to use instead", () => {
  assert.throws(() => localEngine("kokoro:af_heart", "linux", "x64"), /Apple Silicon Macs for now — use an Edge voice/);
  assert.throws(() => localEngine("qwen:aiden", "darwin", "x64"), /Apple Silicon/);
});

test("Kokoro hears re-CORD in a demo, RE-cord after 'a', and deh-mohz for demos", () => {
  const say = (t: string) => execFileSync("python3", [SCRIPT, "--pronounce", t], { encoding: "utf8" }).trim();
  assert.equal(say("then pressed record."), "then pressed [record](/ɹəkˈɔɹd/).");
  assert.equal(say("Record a demo of my app."), "[Record](/ɹəkˈɔɹd/) a [demo](/dˈɛmO/) of my app.");
  assert.equal(say("Keep a record of every take."), "Keep a record of every take.");
  assert.equal(say("Stop re-recording your demos."), "Stop re-recording your [demos](/dˈɛmOz/).");
});

test("a local voice's version is part of its cache key; an Edge voice's key is unchanged", () => {
  const edge = voiceCachePath("hello", "en-US-AndrewNeural");
  assert.match(edge, /[0-9a-f]{64}\.mp3$/);
  assert.notEqual(voiceCachePath("hello", "kokoro:af_heart"), voiceCachePath("hello", "kokoro:am_michael"));
  assert.ok(fs.readFileSync("src/voice.ts", "utf8").includes("LOCAL_VOICE.test(voice) ? `${voice}\\0${LOCAL_VOICE_VERSION}`"));
  assert.ok(fs.readFileSync("src/render.ts", "utf8").includes("voEngine:"), "the render cache hears a local voice change");
});

const canSpeak = process.platform === "darwin" && process.arch === "arm64"
  && spawnSync("uvx", ["--version"], { stdio: "ignore" }).status === 0 && localModelReady("kokoro:af_heart");

test("Kokoro speaks, with sentence timings, at Edge's loudness", { skip: canSpeak ? false : "needs an Apple Silicon Mac with uv and the Kokoro model" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-voice-"));
  const prev = process.env.RETAKE_TTS_CACHE;
  process.env.RETAKE_TTS_CACHE = dir;
  try {
    const out = path.join(dir, "vo.mp3");
    const cues = synthesizeWithCues("Press record. Two demos, one take.", "kokoro:af_heart", out);
    assert.equal(cues.length, 2);
    assert.ok(cues[1].start > cues[0].end, "the second sentence follows the first");
    const meas = spawnSync(ffmpegBin(), ["-hide_banner", "-nostats", "-i", out, "-af", "ebur128=framelog=quiet", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(meas.slice(meas.lastIndexOf("Summary")))?.[1]);
    assert.ok(Math.abs(lufs - -19.8) < 2.5, `loudness ${lufs} LUFS, wanted ~-19.8`);
  } finally {
    if (prev === undefined) delete process.env.RETAKE_TTS_CACHE; else process.env.RETAKE_TTS_CACHE = prev;
  }
});

/** The test that was missing. Onboarding offered Edge, Aiden and Kokoro for
    months while Retake could speak only Edge: every check looked at the
    screen, none at the result. Each choice must name a voice Retake speaks. */
test("every voice the onboarding offers is one Retake can speak", () => {
  const server = fs.readFileSync("src/ui/server.ts", "utf8");
  const offered = /narration = \(\[([^\]]+)\] as const\)/.exec(server)?.[1].match(/"(\w+)"/g)?.map((s) => s.slice(1, -1)) ?? [];
  assert.deepEqual(offered.sort(), ["aiden", "edge", "kokoro", "silent"]);
  for (const choice of offered.filter((c) => c !== "silent" && c !== "edge")) {
    const said = new RegExp(`chose the local ${choice[0].toUpperCase() + choice.slice(1)} voice[^"]*?voiceover\\.voice: ((?:kokoro|qwen):[a-z_]+)`, "i").exec(server);
    assert.ok(said, `onboarding's ${choice} instruction names no voice id`);
    assert.ok(LOCAL_VOICE.test(said![1]), `${choice} → ${said![1]} is not a voice Retake can speak`);
    assert.ok(Object.values(VOICES).some((v) => v.id === said![1]), `${said![1]} has no routine name`);
  }
});

const canSpeakAiden = process.platform === "darwin" && process.arch === "arm64"
  && spawnSync("uvx", ["--version"], { stdio: "ignore" }).status === 0 && localModelReady("qwen:aiden");

test("Aiden speaks through Retake too", { skip: canSpeakAiden ? false : "needs an Apple Silicon Mac with uv and the Qwen3 model" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-aiden-"));
  const prev = process.env.RETAKE_TTS_CACHE;
  process.env.RETAKE_TTS_CACHE = dir;
  try {
    const cues = synthesizeWithCues("Your agent records the video. You review the take.", "qwen:aiden", path.join(dir, "vo.mp3"));
    assert.equal(cues.length, 2);
    assert.ok(fs.statSync(path.join(dir, "vo.mp3")).size > 10_000);
  } finally {
    if (prev === undefined) delete process.env.RETAKE_TTS_CACHE; else process.env.RETAKE_TTS_CACHE = prev;
  }
});
