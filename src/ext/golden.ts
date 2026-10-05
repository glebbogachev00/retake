/**
 * Human-approved video references and cheap, deterministic comparisons.
 *
 * A golden is evidence, not a copy of the source video. The ledger keeps
 * hashes, media facts, an approved contact sheet and approval provenance. It
 * never stores an absolute source path or copies a full MP4 into the repo.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ffmpegBin } from "../media-bin.js";

export type MediaFacts = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  pixelFormat: string;
  sar: string;
  audio: boolean;
  audioCodec: string | null;
  audioHz: number | null;
  audioLayout: string | null;
};

export type GoldenVariant = {
  label: string;
  containerSha256: string;
  videoSha256: string;
  audioSha256: string | null;
  media: MediaFacts;
};

export type GoldenRubric = {
  story: "pass" | "watch" | "fail";
  framing: "pass" | "watch" | "fail";
  timing: "pass" | "watch" | "fail";
  text: "pass" | "watch" | "fail";
  motion: "pass" | "watch" | "fail";
};

export type GoldenReference = {
  id: string;
  title: string;
  approvedBy: string;
  approvedAt: string;
  rubric: GoldenRubric;
  contact: string;
  contactSha256: string;
  visualSha256: string;
  variants: GoldenVariant[];
};

export type GoldenLedger = { version: 1; references: GoldenReference[] };
export type ScoreRow = { name: string; status: "pass" | "fail"; expected: string; actual: string };
export type GoldenScore = {
  ok: boolean;
  reference: string;
  referenceVisualSha256: string;
  candidate: MediaFacts & { filename: string; containerSha256: string; videoSha256: string; audioSha256: string | null };
  rows: ScoreRow[];
};

const EMPTY: GoldenLedger = { version: 1, references: [] };
const INDEX = "index.json";
const MIN_REFERENCES = 5;
const MAX_REFERENCES = 8;

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function streamHash(file: string, stream: "v" | "a"): string | null {
  const result = spawnSync(ffmpegBin(), ["-v", "error", "-i", file, "-map", `0:${stream}:0`, "-c", "copy", "-f", "hash", "-hash", "sha256", "-"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return /SHA256=([a-f0-9]{64})/i.exec(result.stdout)?.[1]?.toLowerCase() ?? null;
}

export function inspectMedia(file: string): MediaFacts & { containerSha256: string; videoSha256: string; audioSha256: string | null } {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Error(`media does not exist: ${file}`);
  const stderr = String(spawnSync(ffmpegBin(), ["-hide_banner", "-i", absolute], { encoding: "utf8" }).stderr ?? "");
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const videoLine = stderr.split(/\r?\n/).find((line) => /Stream #.*Video:/.test(line));
  if (!duration || !videoLine) throw new Error(`not a readable video: ${file}`);
  const dimensions = /,\s*(\d{2,5})x(\d{2,5})(?:\s+\[SAR\s+([^\s\]]+))?/.exec(videoLine);
  const fps = /,\s*(\d+(?:\.\d+)?)\s*fps/.exec(videoLine);
  const videoCodec = /Video:\s*([^\s(,]+)/.exec(videoLine)?.[1] ?? "unknown";
  const pixelFormat = /Video:.*?,\s*([a-zA-Z0-9_]+)(?:\([^)]*\))?,\s*\d{2,5}x\d{2,5}/.exec(videoLine)?.[1] ?? "unknown";
  const videoSha256 = streamHash(absolute, "v");
  if (!dimensions || !fps || !videoSha256) throw new Error(`not a readable video: ${file}`);
  const audioLine = stderr.split(/\r?\n/).find((line) => /Stream #.*Audio:/.test(line));
  const audioCodec = audioLine ? /Audio:\s*([^\s(,]+)/.exec(audioLine)?.[1] ?? "unknown" : null;
  const audioHz = audioLine ? Number(/,\s*(\d+)\s*Hz/.exec(audioLine)?.[1] ?? 0) || null : null;
  const audioLayout = audioLine ? /,\s*\d+\s*Hz,\s*([^,]+)/.exec(audioLine)?.[1]?.trim() ?? null : null;
  return {
    duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    width: Number(dimensions[1]),
    height: Number(dimensions[2]),
    fps: Number(fps[1]),
    videoCodec,
    pixelFormat,
    sar: dimensions[3] ?? "1:1",
    audio: !!audioLine,
    audioCodec,
    audioHz,
    audioLayout,
    containerSha256: sha256(absolute),
    videoSha256,
    audioSha256: audioLine ? streamHash(absolute, "a") : null,
  };
}

function isLedger(value: unknown): value is GoldenLedger {
  if (!value || typeof value !== "object") return false;
  const ledger = value as GoldenLedger;
  return ledger.version === 1 && Array.isArray(ledger.references);
}

export function loadGoldenLedger(root = path.resolve("goldens")): GoldenLedger {
  const file = path.join(path.resolve(root), INDEX);
  if (!fs.existsSync(file)) return structuredClone(EMPTY);
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`golden ledger is not valid JSON: ${file}`); }
  if (!isLedger(parsed)) throw new Error(`golden ledger has an unsupported shape: ${file}`);
  return parsed;
}

function writeLedger(root: string, ledger: GoldenLedger) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, INDEX);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(ledger, null, 2) + "\n");
  fs.renameSync(temp, file);
}

function relativeArtifact(root: string, file: string): string {
  const rel = path.relative(root, path.resolve(file));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("contact sheet must live inside the golden directory");
  if (!fs.existsSync(path.join(root, rel))) throw new Error(`contact sheet does not exist: ${file}`);
  return rel;
}

export function assertGoldenId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new Error("golden id must be 2–64 lowercase letters, numbers, or hyphens");
}

export function assertGoldenApproval(input: { id: string; title: string; approvedBy: string; rubric: GoldenRubric }): void {
  assertGoldenId(input.id);
  if (!input.title.trim()) throw new Error("golden title is required");
  if (!input.approvedBy.trim()) throw new Error("--approved-by is required; an agent cannot approve its own reference");
  const ratings = Object.values(input.rubric ?? {});
  if (ratings.length !== 5 || ratings.some((rating) => !["pass", "watch", "fail"].includes(rating))) throw new Error("a completed rubric is required for story, framing, timing, text, and motion");
}

export function addGolden(rootInput: string, source: string, input: { id: string; title: string; approvedBy: string; rubric: GoldenRubric; contact?: string; variant?: string; approvedAt?: string }): GoldenReference {
  const root = path.resolve(rootInput);
  assertGoldenApproval(input);
  const inspected = inspectMedia(source);
  const media: MediaFacts = {
    duration: inspected.duration, width: inspected.width, height: inspected.height, fps: inspected.fps,
    videoCodec: inspected.videoCodec, pixelFormat: inspected.pixelFormat, sar: inspected.sar,
    audio: inspected.audio, audioCodec: inspected.audioCodec, audioHz: inspected.audioHz, audioLayout: inspected.audioLayout,
  };
  const variant: GoldenVariant = {
    label: input.variant?.trim() || "default",
    containerSha256: inspected.containerSha256,
    videoSha256: inspected.videoSha256,
    audioSha256: inspected.audioSha256,
    media,
  };
  const ledger = loadGoldenLedger(root);
  const containerOwner = ledger.references.find((reference) => reference.variants.some((item) => item.containerSha256 === variant.containerSha256));
  const existing = ledger.references.find((reference) => reference.id === input.id);
  if (containerOwner) {
    if (containerOwner.id === input.id) return containerOwner;
    throw new Error(`this container already belongs to ${containerOwner.id}`);
  }
  const otherVisual = ledger.references.find((reference) => reference.visualSha256 === inspected.videoSha256 && reference.id !== input.id);
  if (otherVisual) throw new Error(`this visual stream already belongs to ${otherVisual.id}; add it there as an audio variant`);
  if (existing) {
    if (existing.visualSha256 !== inspected.videoSha256) throw new Error(`${input.id} already exists with a different visual stream`);
    if (existing.variants.some((item) => item.label === variant.label)) throw new Error(`variant ${variant.label} already exists in ${input.id}`);
    existing.variants.push(variant);
    writeLedger(root, ledger);
    return existing;
  }
  if (ledger.references.length >= MAX_REFERENCES) throw new Error("the approved set already has eight visual references; replace a weak reference instead of growing an unbounded library");
  if (!input.contact) throw new Error("a generated contact sheet is required for a new golden family");
  const suppliedContact = relativeArtifact(root, input.contact);
  const finalContact = path.join(input.id, "contact.png");
  const finalAbsolute = path.join(root, finalContact);
  const staged = `${finalAbsolute}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(finalAbsolute), { recursive: true });
  fs.copyFileSync(path.join(root, suppliedContact), staged);
  const contactSha256 = sha256(staged);
  const reference: GoldenReference = {
    id: input.id,
    title: input.title.trim(),
    approvedBy: input.approvedBy.trim(),
    approvedAt: input.approvedAt ?? new Date().toISOString(),
    rubric: input.rubric,
    contact: finalContact,
    contactSha256,
    visualSha256: inspected.videoSha256,
    variants: [variant],
  };
  try {
    fs.renameSync(staged, finalAbsolute);
    ledger.references.push(reference);
    writeLedger(root, ledger);
  } catch (error) {
    fs.rmSync(staged, { force: true });
    fs.rmSync(finalAbsolute, { force: true });
    throw error;
  }
  return reference;
}

export function goldenSetStatus(root: string): { count: number; complete: boolean; message: string } {
  const count = loadGoldenLedger(root).references.length;
  return { count, complete: count >= MIN_REFERENCES && count <= MAX_REFERENCES, message: count >= MIN_REFERENCES && count <= MAX_REFERENCES ? `${count} approved visual references` : `${count} of ${MIN_REFERENCES} minimum approved visual references` };
}

export function verifyGoldenIntegrity(rootInput: string, id?: string): { ok: boolean; lines: string[] } {
  const root = path.resolve(rootInput);
  const refs = loadGoldenLedger(root).references.filter((reference) => !id || reference.id === id);
  if (id && !refs.length) throw new Error(`no golden reference named ${id}`);
  const lines: string[] = [];
  let ok = true;
  for (const reference of refs) {
    const contact = path.join(root, reference.contact);
    const match = fs.existsSync(contact) && sha256(contact) === reference.contactSha256;
    lines.push(`${match ? "pass" : "FAIL"}  ${reference.id}: contact sheet integrity`);
    if (!match) ok = false;
  }
  return { ok, lines };
}

function row(name: string, pass: boolean, expected: string | number | boolean | null, actual: string | number | boolean | null): ScoreRow {
  return { name, status: pass ? "pass" : "fail", expected: String(expected), actual: String(actual) };
}

export function scoreGolden(root: string, candidateFile: string, id: string): GoldenScore {
  const reference = loadGoldenLedger(root).references.find((item) => item.id === id);
  if (!reference) throw new Error(`no golden reference named ${id}`);
  const integrity = verifyGoldenIntegrity(root, id);
  if (!integrity.ok) throw new Error(`golden reference ${id} failed integrity verification`);
  const candidate = inspectMedia(candidateFile);
  const expected = reference.variants[0].media;
  const durationTolerance = Math.max(2, expected.duration * 0.1);
  const rows: ScoreRow[] = [
    row("video", candidate.width > 0 && candidate.height > 0, "readable video stream", candidate.width > 0 && candidate.height > 0),
    row("audio", candidate.audio === expected.audio, expected.audio, candidate.audio),
    row("dimensions", candidate.width === expected.width && candidate.height === expected.height, `${expected.width}x${expected.height}`, `${candidate.width}x${candidate.height}`),
    row("fps", Math.abs(candidate.fps - expected.fps) <= 0.01, expected.fps, candidate.fps),
    row("sample aspect ratio", candidate.sar === expected.sar, expected.sar, candidate.sar),
    row("pixel format", candidate.pixelFormat === expected.pixelFormat, expected.pixelFormat, candidate.pixelFormat),
    row("video codec", candidate.videoCodec === expected.videoCodec, expected.videoCodec, candidate.videoCodec),
    row("duration", Math.abs(candidate.duration - expected.duration) <= durationTolerance, `${expected.duration}s ± ${durationTolerance.toFixed(2)}s`, `${candidate.duration}s`),
  ];
  return {
    ok: rows.every((item) => item.status === "pass"),
    reference: id,
    referenceVisualSha256: reference.visualSha256,
    candidate: { ...candidate, filename: path.basename(candidateFile) },
    rows,
  };
}

export function writeGoldenScorecard(rootInput: string, score: GoldenScore): string {
  const root = path.resolve(rootInput);
  const dir = path.join(root, "scorecards");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${score.reference}-${score.candidate.containerSha256.slice(0, 12)}.json`);
  fs.writeFileSync(file, JSON.stringify(score, null, 2) + "\n");
  return file;
}
