/**
 * Motion pieces rendered from HTML — title cards and callout overlays.
 *
 * Chromium is the motion renderer: a template page defines `__seek(tMs)`
 * which lays the frame out for that exact moment, and Node steps through
 * the timeline one screenshot per video frame. Deterministic to the pixel —
 * the same take renders the same twice — and styled with the same theme as
 * the caption band, so cards look like Retake, not like a slide deck.
 *
 * All of it is render-time: change a title, `retake render`, seconds.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

type Theme = { background: string; ink: string };
const AMBER = "#e8b04b";

const ease = "t<0?0:t>1?1:t*t*(3-2*t)"; // smoothstep, in the page

export type CardStyle = { background: string; ink: string; logo?: string; font?: string; weight: number; ornament: "circles" | "none"; orb?: string };

/** A file as a data: URI, so the card page needs nothing from disk or network. */
function dataUri(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".woff2" ? "font/woff2" : ext === ".woff" ? "font/woff" : ext === ".ttf" ? "font/ttf" : ext === ".otf" ? "font/otf" : "application/octet-stream";
  return `data:${mime};base64,${fs.readFileSync(path.resolve(file)).toString("base64")}`;
}

/**
 * A card that looks like the product rather than like Retake: the mark above
 * the title, the brand's own typeface, its ground and ink, and — if asked —
 * two soft circles in opposite corners. Built to reproduce a north-star card,
 * which before this could only be made outside Retake and recoloured in.
 *
 * Same contract as the plain card: `__seek(ms)` lays out that exact moment,
 * `__still` names the window where nothing moves (the poster comes from it).
 */
function brandedCardHtml(w: number, h: number, c: CardStyle, title: string, subtitle: string | undefined, ms: number): string {
  // Measured off a north-star card at 1920×1080: a 143px mark, the title
  // 66px below it, two lines of ~92px type spanning 192px, wrapping at ~1300px.
  const titleSize = Math.round(Math.min(w * 0.048, h * 0.085));
  const subSize = Math.round(titleSize * 0.4);
  const mark = Math.round(h * 0.133);
  const font = c.font ? `@font-face{font-family:"BrandCard";src:url(${dataUri(c.font)});font-weight:100 900;font-display:block}` : "";
  const family = c.font ? `"BrandCard",Georgia,serif` : `-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif`;
  const logo = c.logo ? `<img class="mark" src="${dataUri(c.logo)}" alt="">` : "";
  const circles = c.ornament === "circles"
    ? `<i class="orb a"></i><i class="orb b"></i>` : "";
  return `<!doctype html><meta charset="utf-8"><style>
  ${font}
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${c.background}}
  .orb{position:absolute;border-radius:50%;background:${c.orb ?? `color-mix(in srgb, ${c.ink} 6%, ${c.background})`}}
  .orb.a{width:${Math.round(h * 0.6)}px;height:${Math.round(h * 0.6)}px;left:${Math.round(-h * 0.25)}px;top:${Math.round(-h * 0.3)}px}
  .orb.b{width:${Math.round(h * 0.7)}px;height:${Math.round(h * 0.7)}px;right:${Math.round(-h * 0.3)}px;bottom:${Math.round(-h * 0.33)}px}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(h * 0.06)}px}
  .mark{width:${mark}px;height:${mark}px;border-radius:${Math.round(mark * 0.22)}px;box-shadow:0 ${Math.round(mark * 0.12)}px ${Math.round(mark * 0.3)}px rgba(0,0,0,.10);opacity:0;object-fit:cover}
  .text{display:flex;flex-direction:column;align-items:center;gap:${Math.round(subSize * 0.8)}px}
  .title{font-family:${family};font-size:${titleSize}px;font-weight:${c.weight};line-height:1.1;letter-spacing:-.022em;color:${c.ink};text-align:center;max-width:${Math.round(w * 0.68)}px;opacity:0;font-variation-settings:"opsz" 144}
  .sub{font-family:${family};font-size:${subSize}px;color:${c.ink};opacity:0;text-align:center;max-width:${Math.round(w * 0.6)}px}
  </style>
  ${circles}
  <div class="wrap">${logo}<div class="text"><div class="title"></div><div class="sub"></div></div></div>
  <script>
  const M = document.querySelector(".mark"), T = document.querySelector(".title"), S = document.querySelector(".sub");
  T.textContent = ${JSON.stringify(title)}; S.textContent = ${JSON.stringify(subtitle ?? "")};
  if (!S.textContent) S.remove();
  const DUR = ${ms}, FADE = Math.min(460, DUR * 0.24), OUT = Math.min(320, DUR * 0.18);
  const ez = (t) => (${ease});
  window.__still = [FADE * 1.6, DUR - OUT];
  window.__seek = (ms) => {
    const a = ez(ms / FADE), b = ez((ms - FADE * 0.35) / FADE), o = ez((DUR - ms) / OUT);
    if (M) { M.style.opacity = Math.min(a, o); M.style.transform = "translateY(" + (1 - a) * 10 + "px)"; }
    T.style.opacity = Math.min(b, o); T.style.transform = "translateY(" + (1 - b) * 12 + "px)";
    if (S.isConnected) { S.style.opacity = Math.min(b, o); }
    return true;
  };
  </script>`;
}

function cardHtml(w: number, h: number, theme: Theme, title: string, subtitle: string | undefined, ms: number): string {
  const titleSize = Math.round(Math.min(w * 0.055, h * 0.14));
  const subSize = Math.round(titleSize * 0.4);
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${theme.background}}
  .wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Arial,sans-serif}
  .title{font-size:${titleSize}px;font-weight:700;letter-spacing:-.02em;color:${theme.ink};opacity:0}
  .rule{height:${Math.max(3, Math.round(titleSize * 0.07))}px;background:${AMBER};border-radius:99px;margin:${Math.round(titleSize * 0.35)}px 0;width:0}
  .sub{font-size:${subSize}px;color:${theme.ink};opacity:0;font-weight:400}
  </style>
  <div class="wrap"><div class="title"></div><div class="rule"></div><div class="sub"></div></div>
  <script>
  const T = document.querySelector(".title"), R = document.querySelector(".rule"), S = document.querySelector(".sub");
  T.textContent = ${JSON.stringify(title)}; S.textContent = ${JSON.stringify(subtitle ?? "")};
  const DUR = ${ms}, FADE = Math.min(420, DUR * 0.22), OUT = Math.min(320, DUR * 0.18);
  const ez = (t) => (${ease});
  // The window in which nothing moves. The rule keeps growing until FADE*2 —
  // well past the title's own fade — so this cannot be guessed from the
  // outside, and the renderer asks the template rather than assuming.
  window.__still = [FADE * 2, DUR - OUT];
  window.__seek = (ms) => {
    const a = ez(ms / FADE);                          // entrance
    const o = ez((DUR - ms) / OUT);                   // exit
    const v = Math.min(a, o);
    T.style.opacity = v; T.style.transform = "translateY(" + (1 - a) * 14 + "px)";
    R.style.width = (ez((ms - FADE * 0.4) / (FADE * 1.6)) * ${Math.round(titleSize * 3.2)}) * Math.min(1, o + 0.0) + "px";
    R.style.opacity = Math.min(1, o + 0.2);
    S.style.opacity = v; S.style.transform = "translateY(" + (1 - a) * 10 + "px)";
    return true;
  };
  </script>`;
}

function calloutHtml(w: number, h: number, box: { x: number; y: number; width: number; height: number }, label: string | undefined, ms: number, fontSize: number, ink: string): string {
  const pad = 10;
  const r = { x: box.x - pad, y: box.y - pad, w: box.width + 2 * pad, h: box.height + 2 * pad };
  const below = r.y + r.h + 18 + fontSize * 2 < h; // label under the ring when there is room
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}
  .ring{position:absolute;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border:3px solid ${AMBER};border-radius:14px;box-shadow:0 0 0 3px rgba(0,0,0,.06);opacity:0}
  .tag{position:absolute;left:${Math.max(8, Math.min(w - 8, r.x))}px;top:${below ? r.y + r.h + 12 : Math.max(8, r.y - fontSize * 1.9 - 12)}px;background:${ink};color:#f4f4ef;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",Arial,sans-serif;font-size:${fontSize}px;font-weight:600;line-height:1;padding:${Math.round(fontSize * 0.55)}px ${Math.round(fontSize * 0.8)}px;border-radius:10px;opacity:0;max-width:${Math.round(w * 0.6)}px;white-space:nowrap}
  </style>
  <div class="ring"></div>${label ? '<div class="tag"></div>' : ""}
  <script>
  const ring = document.querySelector(".ring"), tag = document.querySelector(".tag");
  if (tag) tag.textContent = ${JSON.stringify(label ?? "")};
  const DUR = ${ms}, IN = Math.min(360, DUR * 0.25), OUT = Math.min(280, DUR * 0.2);
  const ez = (t) => (${ease});
  // The tag lands last, at IN*1.6 — later than the ring's own entrance.
  window.__still = [IN * 1.6, DUR - OUT];
  window.__seek = (ms) => {
    const a = ez(ms / IN), o = ez((DUR - ms) / OUT), v = Math.min(a, o);
    ring.style.opacity = v;
    ring.style.transform = "scale(" + (1.12 - 0.12 * a) + ")";
    if (tag) { tag.style.opacity = Math.min(ez((ms - IN * 0.6) / IN), o); tag.style.transform = "translateY(" + (1 - a) * 6 + "px)"; }
    return true;
  };
  </script>`;
}

/** Screenshot a __seek()-driven page at every frame; returns the frame dir.
 *
 * A card only MOVES at its ends: it eases in, holds, eases out. Photographing
 * the held middle was paying ~250ms a frame for an unchanging picture — 30s of
 * a launch cut's render, for two cards. So the held frames are copies of the
 * settled one, at a millisecond each.
 *
 * Which frames those are is the template's business, not this function's. It
 * publishes `__still = [from, to]`, because the answer is not guessable from
 * outside: the card's rule keeps growing until twice the title's fade, and a
 * renderer that assumed otherwise froze it half-drawn. A template with no
 * `__still` gets every frame shot — the slow path is the safe default. */
async function renderFrames(html: string, w: number, h: number, ms: number, fps: number, transparent: boolean): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-frames-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(html, { waitUntil: "load" });
    const frames = Math.max(2, Math.round((ms / 1000) * fps));
    const still = await page.evaluate(() => (window as unknown as { __still?: [number, number] }).__still);
    // One frame of margin at each end, so rounding never lands the copied
    // frame on a moment the template was still moving.
    const margin = 1000 / fps;
    const held = (t: number) => !!still && still[1] - still[0] > 2 * margin && t * 1000 >= still[0] + margin && t * 1000 <= still[1] - margin;
    let settled = "";
    for (let i = 0; i < frames; i++) {
      const t = i / fps;
      const file = path.join(dir, `f${String(i).padStart(5, "0")}.png`);
      if (!held(t) || !settled) {
        await page.evaluate((ms2) => (window as unknown as { __seek: (t: number) => void }).__seek(ms2), t * 1000);
        await page.screenshot({ path: file, omitBackground: transparent });
        if (held(t) && !settled) settled = file;
      } else {
        fs.copyFileSync(settled, file);
      }
    }
    return dir;
  } finally {
    await browser.close();
  }
}

/** A title card as an H.264 segment at the final canvas size, plus (for the
    intro) the settled middle frame as cover.png — the poster. */
export async function renderCard(
  ffmpeg: string, outDir: string, kind: "intro" | "outro",
  spec: { title: string; subtitle?: string; ms: number },
  w: number, h: number, fps: number, theme: Theme, style?: CardStyle,
): Promise<{ mp4: string; cover?: string }> {
  const html = style ? brandedCardHtml(w, h, style, spec.title, spec.subtitle, spec.ms) : cardHtml(w, h, theme, spec.title, spec.subtitle, spec.ms);
  const dir = await renderFrames(html, w, h, spec.ms, fps, false);
  const mp4 = path.join(outDir, `.card-${kind}.mp4`);
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(dir, "f%05d.png"), "-c:v", "libx264", "-crf", "17", "-preset", "veryfast", "-pix_fmt", "yuv420p", mp4], { stdio: "inherit" });
  let cover: string | undefined;
  if (kind === "intro") {
    const frames = fs.readdirSync(dir).sort();
    const settled = frames[Math.min(frames.length - 1, Math.round(frames.length * 0.55))];
    cover = path.join(outDir, "cover.png");
    fs.copyFileSync(path.join(dir, settled), cover);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { mp4, cover };
}

/** A callout as a VP9 segment with alpha, overlaid onto the take at render. */
export async function renderCalloutOverlay(
  ffmpeg: string, outDir: string, index: number,
  c: { box: { x: number; y: number; width: number; height: number }; label?: string; ms: number },
  w: number, h: number, fps: number, fontSize: number, ink: string,
): Promise<string> {
  const dir = await renderFrames(calloutHtml(w, h, c.box, c.label, c.ms, fontSize, ink), w, h, c.ms, fps, true);
  const webm = path.join(outDir, `.callout-${index}.webm`);
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(dir, "f%05d.png"), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "28", webm], { stdio: "inherit" });
  fs.rmSync(dir, { recursive: true, force: true });
  return webm;
}

/** A cover built from a real frame of the video with the title laid over it —
    a screenshot plus a few words, which is what actually stops a scroll. Not
    a skin of the centred card: the product is the picture. */
export async function renderTitledCover(
  ffmpeg: string, frame: string, out: string,
  spec: { title: string; subtitle?: string },
  w: number, h: number, theme: Theme,
): Promise<string> {
  const b64 = fs.readFileSync(frame).toString("base64");
  const titleSize = Math.round(Math.min(w * 0.045, h * 0.1));
  const subSize = Math.round(titleSize * 0.42);
  const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${theme.background};font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Arial,sans-serif}
  .shot{position:absolute;inset:0;background:url(data:image/png;base64,${b64}) center/cover no-repeat}
  .veil{position:absolute;inset:0;background:linear-gradient(to bottom, rgba(0,0,0,0) 38%, rgba(0,0,0,.14) 58%, ${theme.background} 78%)}
  .txt{position:absolute;left:0;right:0;bottom:${Math.round(h * 0.055)}px;text-align:center;padding:0 ${Math.round(w * 0.08)}px}
  .t{font-size:${titleSize}px;font-weight:700;letter-spacing:-.02em;color:${theme.ink};margin:0}
  .r{height:${Math.max(3, Math.round(titleSize * 0.08))}px;width:${Math.round(titleSize * 2.6)}px;background:${AMBER};border-radius:99px;margin:${Math.round(titleSize * 0.3)}px auto}
  .s{font-size:${subSize}px;color:${theme.ink};margin:0;opacity:.75}
  </style>
  <div class="shot"></div><div class="veil"></div>
  <div class="txt"><p class="t">${escapeHtml(spec.title)}</p><div class="r"></div>${spec.subtitle ? `<p class="s">${escapeHtml(spec.subtitle)}</p>` : ""}</div>`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: out });
    return out;
  } finally {
    await browser.close();
  }
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** @internal The card template, exported so test/cards.test.ts can prove the
    frame-skipping is byte-identical to shooting every frame. */
export const __test_cardHtml = cardHtml;
