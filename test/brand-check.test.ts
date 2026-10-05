/** The north star lends its format; the product's brand lends its colours.
    So the frame around the app is judged on geometry against the north star,
    and on colour against the brand — never colour against the north star,
    which failed every product whose north star was another product's video. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ffmpegBin } from "../src/media-bin.js";
import { RoutineSchema, compareToReference } from "../src/routine.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-brand-"));
const ff = ffmpegBin();

/** A 4-second 640×360 "video": a matte with an app-coloured box inset. */
function video(name: string, matte: string, inset: { x: number; y: number; w: number; h: number }): string {
  const out = path.join(dir, `${name}.mp4`);
  execFileSync(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=${matte}:s=640x360:d=4:r=10`,
    "-vf", `drawbox=x=${inset.x}:y=${inset.y}:w=${inset.w}:h=${inset.h}:color=0xeeeeee:t=fill`, "-pix_fmt", "yuv420p", out]);
  return out;
}

const SAME = { x: 34, y: 20, w: 572, h: 320 };
const north = video("north", "0x2f5d3f", SAME);

const routine = (matte: string) => RoutineSchema.parse({ cards: false, theme: { background: matte, ink: "#edefe8" } });

test("same inset in the product's own colour passes", async () => {
  const cut = video("retake", "0x191d19", SAME);
  const [frame] = await compareToReference(ff, north, cut, routine("#191d19"), path.join(dir, "w1"));
  assert.equal(frame.pass, true, `${frame.note} (${frame.score})`);
});

test("the north star's colour on a product whose brand is different fails", async () => {
  const cut = video("green", "0x2f5d3f", SAME);
  const [frame] = await compareToReference(ff, north, cut, routine("#191d19"), path.join(dir, "w2"));
  assert.equal(frame.pass, false);
  assert.match(frame.note, /not the brand's #191d19/);
});

test("a different inset fails, whatever the colour", async () => {
  const cut = video("full", "0x191d19", { x: 4, y: 3, w: 632, h: 354 });
  const [frame] = await compareToReference(ff, north, cut, routine("#191d19"), path.join(dir, "w3"));
  assert.equal(frame.pass, false, `scored ${frame.score}`);
});
