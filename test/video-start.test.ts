/** Where the take starts in the video. On localhost every candidate moment
    lands within a few hundredths of a second, so a wrong one never shows; on
    a real site the server's first answer came 1–1.5s after the video's first
    frame, the cut landed that early, and the demo opened on blank white —
    with every cursor move and caption that late too. This server answers
    slowly on purpose, like a real site, and the take must open on the page. */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { blankLead, record } from "../src/record.js";
import { loadManifest } from "../src/manifest.js";
import { ffmpegBin } from "../src/media-bin.js";

const PORT = 4417;
const PAGE = `<!doctype html><title>slow</title><body style="margin:0;background:#1d3b2a;color:#f4f1e8;font:64px system-ui">
<h1 id="here" style="margin:80px">A page that took its time</h1><p style="margin:80px;font-size:32px">with something on it</p></body>`;
const server = http.createServer((_q, r) => { setTimeout(() => { r.writeHead(200, { "content-type": "text/html" }); r.end(PAGE); }, 1500); });

test.before(() => new Promise<void>((ok) => server.listen(PORT, "127.0.0.1", ok)));
test.after(() => new Promise<void>((ok) => { server.close(() => ok()); }));

/** Brightest minus darkest luma in one frame: near 0 is a blank frame. */
function contrastAt(video: string, at: number): number {
  const out = execFileSync(ffmpegBin(), ["-hide_banner", "-ss", at.toFixed(3), "-i", video, "-frames:v", "1", "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const min = Number(/YMIN=(\d+)/.exec(out)?.[1] ?? 0), max = Number(/YMAX=(\d+)/.exec(out)?.[1] ?? 0);
  return max - min;
}

test("a slow server does not leave blank frames at the front of the take", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "video-start-"));
  const f = path.join(dir, "t.yaml");
  fs.writeFileSync(f, [
    "name: t", `url: http://127.0.0.1:${PORT}/`, "preset: draft", "cursor: false", "waitForSelector: \"#here\"",
    "steps:", "  - { action: scene, label: a }", "  - { action: wait, ms: 1200 }",
  ].join("\n"));
  const out = path.join(dir, "out");
  fs.mkdirSync(out);
  const take = await record(loadManifest(f).manifest, { outDir: out, manifestDir: dir, headed: false, log: () => {} });
  assert.ok(take.video && fs.existsSync(take.video), "a video was recorded");
  // 0.4s in: the old cut left ~1.5s of blank here, so this still catches it,
  // while a busy machine's slow first paint is not mistaken for the bug.
  const opening = contrastAt(take.video!, take.trimBefore + 0.4);
  assert.ok(opening > 60, `the take opens on a blank frame (contrast ${opening}) — the cut is ${take.trimBefore.toFixed(2)}s, too early`);
});

test("a flat opening is measured from the picture, and a real one is left alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blank-lead-"));
  const v = path.join(dir, "v.mp4");
  // One second of blank white, then a picture with something in it.
  execFileSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=white:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "testsrc=s=320x180:r=30:d=2",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1[o]", "-map", "[o]", "-pix_fmt", "yuv420p", v]);
  const lead = blankLead(v, 0);
  assert.ok(lead >= 0.9 && lead <= 1.1, `measured ${lead}s of blank, wanted ~1s`);
  assert.equal(blankLead(v, 1.2), 0, "a take that opens on the page is not moved");
});
