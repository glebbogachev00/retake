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

/** The app made the viewer wait: show the start, fast-forward the rest. */
const WAITING = new Set(["waitFor", "navigate"]);
/** Only stretches meaningfully longer than what we would keep are worth a cut. */
const SLACK = 0.6;
/** Typing is not dead time — it is the person speaking — so it keeps its
    start AND its finish at real speed and only accelerates the middle. Every
    keystroke is a round-trip to the browser (~57ms whatever `delay` says), so
    a real sentence costs five seconds nobody watches. */
const TYPE_BUDGET = 2.4;
const TYPE_HEAD = 0.8;
const TYPE_TAIL = 0.7;
/** A resolved target can still spend seconds under the pointer while a live
 * page settles. Keep the approach and final hover at real speed, but do not
 * make the viewer watch that invisible browser latency. */
const HOVER_BUDGET = 1.8;
const HOVER_HEAD = 0.55;
const HOVER_TAIL = 0.45;
/** A Playwright click can remain open while the browser waits for navigation.
 * Preserve the cursor approach, click ripple, and the first settled result, but
 * accelerate only the silent browser-latency middle. Normal clicks are untouched. */
const CLICK_BUDGET = 1.8;
const CLICK_HEAD = 1.1;
const CLICK_TAIL = 0.45;

/** Plan the warp: 1× everywhere except the tail of each long app-wait and the
    middle of each long typing run. */
export function planIdle(take: Take, keepSeconds: number, pauses: (number | undefined)[] = []): WarpSegment[] {
  const segs: WarpSegment[] = [];
  for (const entry of take.timeline) {
    if (!entry.ok) continue;
    // A step's own `pauseAfter` is the author's pacing, like a `wait`: never
    // compressed. It is the tail of the step's timeline entry, so cut it off
    // before judging what is the app's. A green-flag click held 14.8s for an
    // animation to play came out 1.5s long.
    const pause = Math.max(0, pauses[entry.index] ?? 0);
    const e = { ...entry, end: Math.max(entry.start, entry.end - pause) };
    const dur = e.end - e.start;
    if (WAITING.has(e.action)) {
      if (dur < keepSeconds + SLACK) continue;
      // Head at real speed, tail fast-forwarded into the remaining budget.
      const head = keepSeconds * 0.6;
      const shownTail = keepSeconds * 0.4;
      segs.push({ from: e.start + head, to: e.end, rate: (dur - head) / shownTail });
    } else if (e.action === "type" || e.action === "fill") {
      if (dur < TYPE_BUDGET + SLACK) continue;
      const middle = dur - TYPE_HEAD - TYPE_TAIL;
      const shownMiddle = Math.max(0.3, TYPE_BUDGET - TYPE_HEAD - TYPE_TAIL);
      segs.push({ from: e.start + TYPE_HEAD, to: e.end - TYPE_TAIL, rate: middle / shownMiddle });
    } else if (e.action === "hover") {
      if (dur < HOVER_BUDGET + SLACK) continue;
      const middle = dur - HOVER_HEAD - HOVER_TAIL;
      const shownMiddle = HOVER_BUDGET - HOVER_HEAD - HOVER_TAIL;
      segs.push({ from: e.start + HOVER_HEAD, to: e.end - HOVER_TAIL, rate: middle / shownMiddle });
    } else if (e.action === "click") {
      if (dur < CLICK_BUDGET + SLACK) continue;
      const middle = dur - CLICK_HEAD - CLICK_TAIL;
      const shownMiddle = CLICK_BUDGET - CLICK_HEAD - CLICK_TAIL;
      segs.push({ from: e.start + CLICK_HEAD, to: e.end - CLICK_TAIL, rate: middle / shownMiddle });
    }
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
    const e = take.timeline.find((x) => x.start <= s.from && x.end >= s.to);
    const real = e ? e.end - e.start : s.to - s.from;
    const shown = real - (s.to - s.from) + (s.to - s.from) / s.rate;
    return `${e ? e.summary.slice(0, 52) : "wait"}: ${real.toFixed(1)}s shown as ${shown.toFixed(1)}s`;
  });
}
