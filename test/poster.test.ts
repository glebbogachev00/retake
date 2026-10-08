/** The designed poster: the frame, the brand's colour behind the type, the
    mark on a light badge. Pinned on pixels, because a poster that silently
    loses its colour or its badge looks fine in a test that reads no image. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ffmpegBin } from "../src/media-bin.js";
import { renderPoster } from "../src/cards.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-poster-"));
const ff = ffmpegBin();
const pixel = (png: string, x: number, y: number): number[] =>
  [...execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-i", png, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])];

test("the poster carries the brand's colour, its mark and the frame", async () => {
  const frame = path.join(dir, "frame.png");
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=0xf5a623:s=640x360", "-frames:v", "1", frame]);
  const logo = path.join(dir, "logo.svg");
  fs.writeFileSync(logo, `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" fill="#193b92"/></svg>`);
  const out = path.join(dir, "poster.png");
  await renderPoster(frame, out, { title: "Reactor Zero", subtitle: "Made by Long", kicker: "Student project" }, 640, 360, { matte: "#193b92", ground: "#fafafa", logo });
  const info = spawnSync(ff, ["-hide_banner", "-i", out], { encoding: "utf8" }).stderr;
  assert.match(info, /\b640x360\b/, "the poster is the video's size");
  const left = pixel(out, 8, 180);
  assert.ok(Math.abs(left[0] - 0x19) < 30 && Math.abs(left[2] - 0x92) < 30, `the left edge is the brand's colour, got ${left}`);
  const right = pixel(out, 630, 180);
  assert.ok(right[0] > 200 && right[1] > 130, `the right of the frame shows the frame itself, got ${right}`);
  // The badge: light ground behind the mark, top-left.
  const badge = pixel(out, 38, 31);
  assert.ok(badge.every((c) => c > 230), `the mark sits on a light badge, got ${badge}`);
});
