/**
 * Narration holds: each narrated scene lasts as long as its paragraph.
 *
 * Before this, an agent had to time the narration by hand and size every
 * `wait` to fit — and a guess that came up short meant a line running into
 * the next scene and a re-record. Now the agent writes the actions; at render
 * the settled last frame of a scene is held for exactly as long as its
 * paragraph still needs, the way a person narrating lets the picture rest
 * while they finish the thought. Nothing is sped up, nothing re-recorded.
 *
 * Like idle compression this is a pre-pass: the source is re-cut with the
 * holds in it and every clock in the take is shifted through the same map,
 * so captions, camera keys, stills and the voice all land where they should.
 */
import path from "node:path";
import type { Take } from "./record.js";

export type Hold = { at: number; seconds: number };

/** A breath after each paragraph before the picture moves on. */
export const BREATH = 0.6;

/** Source time → held time. A moment at or after a hold moves by its length. */
export function holdTime(holds: Hold[], t: number): number {
  let out = t;
  for (const h of holds) if (t >= h.at - 1e-6) out += h.seconds;
  return out;
}

export function holdTake(take: Take, holds: Hold[]): Take {
  const w = (t: number) => holdTime(holds, t);
  return {
    ...take,
    // trimBefore is before any hold; duration grows by every hold.
    trimBefore: take.trimBefore,
    duration: take.duration + holds.reduce((s, h) => s + h.seconds, 0),
    // A step that ENDS exactly at a hold keeps its end; the next one starts after.
    timeline: take.timeline.map((e) => ({ ...e, start: w(e.start), end: e.end >= e.start ? Math.max(w(e.start), holdTimeEnd(holds, e.end)) : w(e.end) })),
  };
}

function holdTimeEnd(holds: Hold[], t: number): number {
  let out = t;
  for (const h of holds) if (t > h.at + 1e-6) out += h.seconds;
  return out;
}

/** ffmpeg args: cut at each hold, freeze the last frame of the piece before it. */
export function holdFilterArgs(src: string, holds: Hold[], duration: number, out: string): string[] {
  const cuts = [...holds].sort((a, b) => a.at - b.at);
  const pieces: { a: number; b: number; pad: number }[] = [];
  let cur = 0;
  for (const h of cuts) {
    const at = Math.min(duration, Math.max(cur, h.at));
    pieces.push({ a: cur, b: at, pad: h.seconds });
    cur = at;
  }
  pieces.push({ a: cur, b: duration, pad: 0 });
  const live = pieces.filter((p) => p.b - p.a > 0.001 || p.pad > 0);
  const graph =
    live.map((p, i) => `[0:v]trim=start=${p.a.toFixed(3)}:end=${Math.max(p.b, p.a + 0.04).toFixed(3)},setpts=PTS-STARTPTS${p.pad > 0 ? `,tpad=stop_mode=clone:stop_duration=${p.pad.toFixed(3)}` : ""}[h${i}]`).join(";") +
    ";" + live.map((_, i) => `[h${i}]`).join("") + `concat=n=${live.length}:v=1:a=0[out]`;
  return ["-i", path.resolve(src), "-filter_complex", graph, "-map", "[out]", "-an", out];
}

/**
 * Where each narrated scene falls short of its paragraph, and by how much.
 * `windows` are the narrated scenes in SOURCE time; `spoken` the length of
 * each paragraph as performed; `lead` how long after the scene starts the
 * voice comes in.
 */
export function planHolds(windows: { from: number; to: number }[], spoken: number[], lead: number): Hold[] {
  const holds: Hold[] = [];
  for (let k = 0; k < Math.min(windows.length, spoken.length); k++) {
    const need = lead + spoken[k] + BREATH;
    const have = windows[k].to - windows[k].from;
    if (need - have > 0.05) holds.push({ at: windows[k].to, seconds: need - have });
  }
  return holds;
}
