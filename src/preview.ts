import fs from "node:fs";
import path from "node:path";
import type { Manifest } from "./manifest.js";
import { canReuse, type Take } from "./record.js";

export const FAST_PATH_TARGET_SEC = 180;
export type PreviewRenderKind = "initial" | "correction" | "final";
export type PreviewRenderEvent = {
  kind: PreviewRenderKind;
  preset: string;
  seconds: number;
  finishedAt: string;
};

export type PreviewReceipt = {
  version: 2;
  takeFinishedAt: string;
  captureHash: string | null;
  rawVideo: string;
  previewPreset: string;
  captureCount: 1;
  renderCount: number;
  correctionsUsed: number;
  renders: PreviewRenderEvent[];
  captureSec: number;
  renderSec: number;
  totalSec: number;
  targetSec: number;
  withinTarget: boolean;
  overTargetSec: number;
  finalPreset?: string;
  finalizedAt?: string;
  updatedAt: string;
};

const receiptPath = (outDir: string) => path.join(outDir, "preview.json");
const finiteNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const renderKinds = new Set<PreviewRenderKind>(["initial", "correction", "final"]);

function isRenderEvent(value: unknown): value is PreviewRenderEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<PreviewRenderEvent>;
  return typeof event.kind === "string" && renderKinds.has(event.kind as PreviewRenderKind)
    && typeof event.preset === "string" && event.preset.length > 0
    && finiteNonNegative(event.seconds)
    && typeof event.finishedAt === "string" && event.finishedAt.length > 0;
}

function isPreviewReceipt(value: unknown): value is PreviewReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<PreviewReceipt>;
  if (receipt.version !== 2
    || typeof receipt.takeFinishedAt !== "string"
    || !(typeof receipt.captureHash === "string" || receipt.captureHash === null)
    || typeof receipt.rawVideo !== "string"
    || typeof receipt.previewPreset !== "string"
    || receipt.captureCount !== 1
    || !Number.isInteger(receipt.renderCount) || (receipt.renderCount ?? -1) < 0
    || !Number.isInteger(receipt.correctionsUsed) || (receipt.correctionsUsed ?? -1) < 0
    || !Array.isArray(receipt.renders) || !receipt.renders.every(isRenderEvent)
    || receipt.renderCount !== receipt.renders.length
    || receipt.correctionsUsed !== receipt.renders.filter((event) => event.kind === "correction").length
    || !finiteNonNegative(receipt.captureSec)
    || !finiteNonNegative(receipt.renderSec)
    || !finiteNonNegative(receipt.totalSec)
    || receipt.targetSec !== FAST_PATH_TARGET_SEC
    || typeof receipt.withinTarget !== "boolean"
    || !finiteNonNegative(receipt.overTargetSec)
    || typeof receipt.updatedAt !== "string") return false;
  const expectedRenderSec = receipt.renders.reduce((sum, event) => sum + event.seconds, 0);
  const expectedTotal = receipt.captureSec + expectedRenderSec;
  if (Math.abs(receipt.renderSec - expectedRenderSec) > 0.001 || Math.abs(receipt.totalSec - expectedTotal) > 0.001) return false;
  if (receipt.withinTarget !== (receipt.totalSec <= FAST_PATH_TARGET_SEC)) return false;
  if (Math.abs(receipt.overTargetSec - Math.max(0, receipt.totalSec - FAST_PATH_TARGET_SEC)) > 0.001) return false;
  if ((receipt.finalizedAt === undefined) !== (receipt.finalPreset === undefined)) return false;
  if (receipt.previewPreset !== "preview-fast") return false;
  const initialEvents = receipt.renders.filter((event) => event.kind === "initial");
  const finalEvents = receipt.renders.filter((event) => event.kind === "final");
  if (receipt.renders.length > 0 && (initialEvents.length !== 1 || receipt.renders[0].kind !== "initial" || receipt.renders[0].preset !== receipt.previewPreset)) return false;
  if (receipt.renders.length === 0 && initialEvents.length !== 0) return false;
  if ((receipt.correctionsUsed ?? 0) > 1 || finalEvents.length > 1) return false;
  const finalEvent = finalEvents[0];
  if (finalEvent) {
    if (receipt.renders.at(-1) !== finalEvent || finalEvent.preset !== "post-landscape") return false;
    if (receipt.finalPreset !== finalEvent.preset || receipt.finalizedAt !== finalEvent.finishedAt) return false;
  } else if (receipt.finalizedAt !== undefined || receipt.finalPreset !== undefined) return false;
  return true;
}

function writePreviewReceipt(outDir: string, receipt: PreviewReceipt): PreviewReceipt {
  fs.mkdirSync(outDir, { recursive: true });
  const file = receiptPath(outDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(receipt, null, 2));
  fs.renameSync(temp, file);
  return receipt;
}

export function readPreviewReceipt(outDir: string): PreviewReceipt | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(receiptPath(outDir), "utf8"));
    return isPreviewReceipt(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Compare a take against the capture-relevant parts of the current manifest.
 * Output preset changes are normalized back to the dimensions used for the
 * take, because render can fit that raw recording into another canvas.
 */
export function captureMatchesTake(take: Take | null | undefined, manifest: Manifest, manifestDir = process.cwd()): boolean {
  if (!take?.quality) return false;
  const normalized = {
    ...manifest,
    preset: take.quality.preset,
    viewport: { width: take.quality.width, height: take.quality.height },
    scale: take.quality.scale,
    fps: take.quality.fps,
  } as Manifest;
  return canReuse(take, normalized, manifestDir);
}

function matchesTake(receipt: PreviewReceipt, take: Take): boolean {
  return receipt.takeFinishedAt === take.finishedAt
    && receipt.captureHash === (take.captureHash ?? null)
    && receipt.rawVideo === take.video;
}

function withTiming(receipt: PreviewReceipt, renders: PreviewRenderEvent[]): PreviewReceipt {
  const renderSec = renders.reduce((sum, event) => sum + event.seconds, 0);
  const totalSec = receipt.captureSec + renderSec;
  return {
    ...receipt,
    renders,
    renderCount: renders.length,
    correctionsUsed: renders.filter((event) => event.kind === "correction").length,
    renderSec,
    totalSec,
    targetSec: FAST_PATH_TARGET_SEC,
    withinTarget: totalSec <= FAST_PATH_TARGET_SEC,
    overTargetSec: Math.max(0, totalSec - FAST_PATH_TARGET_SEC),
    updatedAt: new Date().toISOString(),
  };
}

export function notePreviewCapture(outDir: string, take: Take, seconds = take.captureSec ?? 0, preset = "preview-fast"): PreviewReceipt {
  if (preset !== "preview-fast") throw new Error("preview capture receipt requires the preview-fast preset");
  if (!take.ok || take.partial || take.brisk || !take.video) {
    throw new Error("preview capture receipt requires a successful complete take");
  }
  const captureSec = Math.max(0, seconds);
  return writePreviewReceipt(outDir, {
    version: 2,
    takeFinishedAt: take.finishedAt,
    captureHash: take.captureHash ?? null,
    rawVideo: take.video,
    previewPreset: preset,
    captureCount: 1,
    renderCount: 0,
    correctionsUsed: 0,
    renders: [],
    captureSec,
    renderSec: 0,
    totalSec: captureSec,
    targetSec: FAST_PATH_TARGET_SEC,
    withinTarget: captureSec <= FAST_PATH_TARGET_SEC,
    overTargetSec: Math.max(0, captureSec - FAST_PATH_TARGET_SEC),
    updatedAt: new Date().toISOString(),
  });
}

export function notePreviewRender(
  outDir: string,
  take: Take,
  input: { preset: string; seconds: number; kind: PreviewRenderKind },
): PreviewReceipt {
  const receipt = readPreviewReceipt(outDir);
  if (!receipt) throw new Error("preview render requires an existing capture receipt");
  if (!matchesTake(receipt, take)) throw new Error("preview capture receipt does not match this take");
  if (receipt.finalizedAt) throw new Error("preview workflow is already finalized");

  const initial = receipt.renders.find((event) => event.kind === "initial");
  if (input.kind === "initial") {
    if (receipt.renders.length > 0) throw new Error("initial preview render was already recorded");
    if (input.preset !== receipt.previewPreset || input.preset !== "preview-fast") {
      throw new Error("initial preview render must use the preview-fast capture preset");
    }
  } else if (!initial) {
    throw new Error("preview workflow requires an initial render before a correction or final");
  }

  if (input.kind === "correction" && receipt.correctionsUsed >= 1) {
    throw new Error("preview correction budget is spent: keep this result or record a new take");
  }
  if (input.kind === "final" && input.preset !== "post-landscape") {
    throw new Error("final render must use the post-landscape preset");
  }

  const event: PreviewRenderEvent = {
    kind: input.kind,
    preset: input.preset,
    seconds: Math.max(0, input.seconds),
    finishedAt: new Date().toISOString(),
  };
  let next = withTiming(receipt, [...receipt.renders, event]);
  if (input.kind === "final") next = { ...next, finalPreset: input.preset, finalizedAt: event.finishedAt };
  return writePreviewReceipt(outDir, next);
}

export function assertFinalReceipt(outDir: string, take: Take): PreviewReceipt {
  const receipt = readPreviewReceipt(outDir);
  if (!receipt) throw new Error("no valid preview receipt");
  if (!matchesTake(receipt, take)) throw new Error("preview receipt is stale for this take");
  if (!receipt.finalizedAt || receipt.finalPreset !== "post-landscape") throw new Error("preview workflow has not been finalized as post-landscape");
  return receipt;
}
