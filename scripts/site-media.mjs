#!/usr/bin/env node
/**
 * Stamp each landing video's REAL pixel size into site/index.html.
 *
 * A hand-written aspect-ratio drifts away from the file the moment a demo is
 * re-recorded, and the browser obeys the number rather than the video —
 * which is how a 1920x1180 take ends up pillarboxed inside black bars on a
 * live page. The dimensions have to come from the file, so this reads them
 * with ffprobe and writes them in.
 *
 * Run it whenever site/media changes, then commit the result.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = path.join(root, "site", "index.html");
let html = fs.readFileSync(page, "utf8");

const ffprobe = (() => {
  for (const c of ["ffprobe", "/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe"]) {
    try { execFileSync(c, ["-version"], { stdio: "ignore" }); return c; } catch { /* next */ }
  }
  throw new Error("ffprobe not found — install ffmpeg, or skip: the page still works, it just cannot reserve the right box before the video loads.");
})();

const sizes = {};
for (const f of fs.readdirSync(path.join(root, "site", "media")).filter((f) => f.endsWith(".mp4"))) {
  const out = execFileSync(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join(root, "site", "media", f)]).toString().trim();
  const [w, h] = out.split(",").map(Number);
  sizes[f.replace(/\.mp4$/, "")] = { w, h };
  console.log(`  ${f}: ${w}x${h}`);
}

const before = html;
html = html.replace(/(\{ file: '([a-z0-9-]+)'[^}]*?)(, w: \d+, h: \d+)?( \})/g, (m, head, name, _old, tail) => {
  const s = sizes[name];
  return s ? `${head}, w: ${s.w}, h: ${s.h}${tail}` : m;
});
fs.writeFileSync(page, html);
console.log(html === before ? "  (no change)" : "  stamped into site/index.html");
