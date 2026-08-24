/**
 * Captions and the band they sit in.
 *
 * The band is decided at render time from the captions themselves: one line
 * of text gets a band that fits one line, two lines a little more — one
 * height for the whole take, so the frame never bounces between scenes.
 * Presets whose canvas is the constraint (square, vertical) keep a fixed
 * band instead, and the page area is the canvas minus that band.
 */
import type { Resolved } from "./manifest.js";

/** Word-wrap long captions; two-line captions break near the middle so no
    word is left orphaned on the second line. */
export function wrap(text: string, max: number): string {
  if (text.length <= max) return text;
  const words = text.split(/\s+/);
  if (text.length <= max * 2) {
    let best = 1, bestDiff = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(" ").length;
      const b = words.slice(i).join(" ").length;
      if (a <= max && b <= max && Math.abs(a - b) < bestDiff) { best = i; bestDiff = Math.abs(a - b); }
    }
    return words.slice(0, best).join(" ") + "\n" + words.slice(best).join(" ");
  }
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > max) { out.push(line); line = w; } else line = line ? line + " " + w : w;
  }
  if (line) out.push(line);
  return out.join("\n");
}

/** Characters per caption line at this width and font size. */
export const maxCharsFor = (width: number, fontSize: number) => Math.max(28, Math.round((width / fontSize) * 1.55));

/** How many lines the longest caption needs. */
export function captionLines(texts: string[], width: number, fontSize: number): number {
  const max = maxCharsFor(width, fontSize);
  return Math.max(1, ...texts.map((t) => wrap(t, max).split("\n").length));
}

/** The band's height for this take: fitted to the text, or the preset's
    fixed band when the canvas is the constraint. 0 when captions are off. */
export function bandHeightFor(q: Pick<Resolved, "captions" | "layout" | "bandHeight">): number {
  if (q.layout !== "band" && q.layout !== "card") return 0;
  if (!q.captions) return 0;
  // Fixed per preset. The default page is the canvas minus this, so the
  // finished video is exactly the preset's size — every take the same shape,
  // and no player letterboxing it.
  return q.bandHeight;
}
