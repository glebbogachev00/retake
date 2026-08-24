/**
 * Idle compression: the app's dead time, shortened at render.
 *
 * The take's own timeline is the honest signal — a waitFor or navigate step
 * records exactly how long the viewer sat looking at nothing changing. Each
 * such stretch is shown as ~keepSeconds: the real start at 1×, then the rest
 * fast-forwarded. The author's `wait` steps are pacing and are never touched;
 * scene holds stay exactly as written.
 *
 * Implemented as a pre-pass: the source video is re-cut into a warped source
 * and every clock in the take (timeline, trim, duration) is remapped through
 * the same piecewise-linear warp, so captions, camera keys and stills land
 * where they always did — the rest of the render pipeline never knows.
 */
import path from "node:path";
import type { Take } from "./record.js";

export type WarpSegment = { from: number; to: number; rate: number };

const COMPRESSIBLE = new Set(["waitFor", "navigate"]);
/** Only stretches meaningfully longer than what we would keep are worth a cut. */
const SLACK = 0.6;

/** Plan the warp: 1× everywhere except the tail of each long app-wait. */
export function planIdle(take: Take, keepSeconds: number): WarpSegment[] {
  const segs: WarpSegment[] = [];
  for (const e of take.timeline) {
    if (!COMPRESSIBLE.has(e.action) || !e.ok) continue;
    const dur = e.end - e.start;
    if (dur < keepSeconds + SLACK) continue;
    // Head at real speed, tail fast-forwarded into the remaining budget.
    const head = keepSeconds * 0.6;
    const shownTail = keepSeconds * 0.4;
    segs.push({ from: e.start + head, to: e.end, rate: (dur - head) / shownTail });
  }
  return segs.sort((a, b) => a.from - b.from);
}

/** Source time → warped time. */
export function warpTime(segs: WarpSegment[], t: number): number {
  let out = t;
  for (const s of segs) {
    if (t <= s.from) break;
    const inSeg = Math.min(t, s.to) - s.from;
    out -= inSeg - inSeg / s.rate;
  }
  return out;
}

/** The take with every clock remapped. */
export function warpTake(take: Take, segs: WarpSegment[]): Take {
  const w = (t: number) => warpTime(segs, t);
  return {
    ...take,
    trimBefore: w(take.trimBefore),
    duration: w(take.duration),
    timeline: take.timeline.map((e) => ({ ...e, start: w(e.start), end: w(e.end) })),
  };
}

/** ffmpeg args to cut the raw source into the warped source. */
export function warpFilterArgs(src: string, segs: WarpSegment[], duration: number, out: string): string[] {
  // Alternating 1× and fast segments covering [0, duration].
  const pieces: { a: number; b: number; rate: number }[] = [];
  let cur = 0;
  for (const s of segs) {
    if (s.from > cur) pieces.push({ a: cur, b: s.from, rate: 1 });
    pieces.push({ a: s.from, b: s.to, rate: s.rate });
    cur = s.to;
  }
  if (cur < duration) pieces.push({ a: cur, b: duration, rate: 1 });
  const graph =
    pieces.map((p, i) => `[0:v]trim=start=${p.a.toFixed(3)}:end=${p.b.toFixed(3)},setpts=(PTS-STARTPTS)/${p.rate.toFixed(4)}[s${i}]`).join(";") +
    ";" + pieces.map((_, i) => `[s${i}]`).join("") + `concat=n=${pieces.length}:v=1:a=0[out]`;
  return ["-i", path.resolve(src), "-filter_complex", graph, "-map", "[out]", "-an", out];
}

/** Human line for the proof log. */
export function describeIdle(take: Take, segs: WarpSegment[]): string[] {
  return segs.map((s) => {
    const e = take.timeline.find((x) => s.to === x.end && s.from > x.start);
    const shown = (s.from - (e?.start ?? s.from)) + (s.to - s.from) / s.rate;
    return `${e ? e.summary : "wait"}: ${(s.to - (e?.start ?? s.from)).toFixed(1)}s of waiting shown as ${shown.toFixed(1)}s`;
  });
}
