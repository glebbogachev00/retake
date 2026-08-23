/**
 * Quality presets: think in the final publishing format, not "browser size".
 *
 * A preset fixes the output canvas, the page scale (CSS zoom — the app lays
 * out at 2× so text is crisp at 1080p while the layout still fits), fps,
 * encoder quality, GIF settings, and the caption layout. Manifests pick one
 * by name and may override individual fields.
 */
export type Layout = "band" | "card" | "overlay-bottom" | "overlay-top" | "none";

export type Preset = {
  name: string;
  /** Output canvas — also the recording viewport (page scale makes the app fill it). */
  width: number;
  height: number;
  /** CSS zoom applied to the page. 2 → the app sees a viewport of width/2 × height/2 CSS px. */
  scale: number;
  fps: number;
  /** libx264 CRF for demo.mp4 (master.mp4 is always CRF 14). */
  crf: number;
  gif: { width: number; fps: number } | false;
  layout: Layout;
  /** Camera zoom used by auto-focus scenes. */
  cameraZoom: number;
  cursorSize: number;
  captionFontSize: number;
  bandHeight: number;
  /** x264: CRF-driven software encode (best quality). videotoolbox: Apple hardware encode (fast previews). */
  encoder: "x264" | "videotoolbox";
  /** Keep a CRF-14 master.mp4 alongside demo.mp4. */
  master: boolean;
  description: string;
};

export const PRESETS: Record<string, Preset> = {
  draft: {
    /* Iteration mode: the SAME 960px layout as preview-fast and post-landscape
       (so selectors, wrapping and timing match the final exactly) at a quarter
       of the pixels — the encoder stops competing with the app being recorded
       on a small machine. Never ship a draft; look at it, then re-record at a
       post preset. */
    name: "draft",
    width: 960, height: 540, scale: 1, fps: 15, crf: 0,
    gif: false, layout: "band", cameraZoom: 1.2,
    cursorSize: 36, captionFontSize: 24, bandHeight: 76,
    encoder: "videotoolbox", master: false,
    description: "Fastest. Same layout as the final at a quarter of the pixels — for iterating, never for shipping.",
  },
  "preview-fast": {
    name: "preview-fast",
    width: 1920, height: 1080, scale: 2, fps: 24, crf: 0,
    gif: false, layout: "band", cameraZoom: 1.25,
    cursorSize: 72, captionFontSize: 46, bandHeight: 150,
    encoder: "videotoolbox", master: false,
    description: "Same framing as post, hardware-encoded MP4 only. For checking timing and framing fast.",
  },
  "proof-fast": {
    name: "proof-fast",
    width: 960, height: 720, scale: 1, fps: 24, crf: 24,
    gif: false, layout: "band", cameraZoom: 1.2,
    cursorSize: 40, captionFontSize: 26, bandHeight: 84,
    encoder: "videotoolbox", master: false,
    description: "Small, quick internal check.",
  },
  "post-landscape": {
    name: "post-landscape",
    width: 1920, height: 1080, scale: 2, fps: 30, crf: 17,
    gif: false, layout: "band", cameraZoom: 1.25,
    cursorSize: 72, captionFontSize: 46, bandHeight: 150,
    encoder: "x264", master: true,
    description: "1080p, 30fps, CRF 17. The general-purpose demo. GIF on request.",
  },
  "post-square": {
    name: "post-square",
    width: 1080, height: 1080, scale: 1.6, fps: 30, crf: 17,
    gif: false, layout: "band", cameraZoom: 1.25,
    cursorSize: 60, captionFontSize: 40, bandHeight: 130,
    encoder: "x264", master: true,
    description: "1080×1080, feed-friendly.",
  },
  "post-vertical": {
    name: "post-vertical",
    width: 1080, height: 1920, scale: 2, fps: 30, crf: 17,
    gif: false, layout: "band", cameraZoom: 1.3,
    cursorSize: 60, captionFontSize: 44, bandHeight: 170,
    encoder: "x264", master: true,
    description: "9:16 for shorts/reels. Apps with a narrow column suit it best.",
  },
  "docs-gif": {
    name: "docs-gif",
    width: 1440, height: 900, scale: 1.5, fps: 24, crf: 20,
    gif: { width: 900, fps: 15 }, layout: "band", cameraZoom: 1.2,
    cursorSize: 48, captionFontSize: 32, bandHeight: 100,
    encoder: "x264", master: false,
    description: "README/docs GIF, 900px wide.",
  },
  master: {
    name: "master",
    width: 1920, height: 1080, scale: 2, fps: 30, crf: 12,
    gif: false, layout: "band", cameraZoom: 1.25,
    cursorSize: 72, captionFontSize: 46, bandHeight: 150,
    encoder: "x264", master: true,
    description: "Highest quality, slowest. Archive/source render.",
  },
};

export const DEFAULT_PRESET = "post-landscape";

export function presetNames(): string[] {
  return Object.keys(PRESETS);
}
