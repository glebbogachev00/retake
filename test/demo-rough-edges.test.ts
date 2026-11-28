/**
 * Four demo-side rough edges found while recording the "what changed in
 * Retake" tour: validate's video size and silent unknown keys, a contact sheet
 * that doubled its moments and stopped halfway, `check` and compressIdle, and
 * the Watch screen at the recording presets.
 */
import "../src/browser-home.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { loadManifest, warnings } from "../src/manifest.js";
import { check, contactSelect, contactTimes, ffmpegBin, lastFrameTime } from "../src/render.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "retake-rough-"));
const manifest = (dir: string, yaml: string) => { const f = path.join(dir, "demo.yaml"); fs.writeFileSync(f, yaml); return loadManifest(f).manifest; };
/** A real H.264 clip, 30fps, so probe and select see what a take would give them. */
const clip = (dir: string, seconds: number, name = "demo.mp4") => {
  const f = path.join(dir, name);
  const r = spawnSync(ffmpegBin(), ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=320x180:rate=30:duration=${seconds}`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", f]);
  assert.equal(r.status, 0, String(r.stderr));
  return f;
};

// ---------- (c) check judges the video that ships ----------

/** A finished take whose one waitFor held the app for 40s, rendered to a short clip. */
function stalledTake(dir: string, action: "waitFor" | "wait") {
  const video = clip(dir, 12, "raw.mp4");
  fs.copyFileSync(video, path.join(dir, "demo.mp4"));
  const take = {
    video, screenshots: [], startedAt: "", finishedAt: "", ok: true, trimBefore: 0, duration: 45,
    quality: { preset: "draft", width: 960, height: 464, scale: 1, fps: 30 },
    timeline: [
      { index: 0, action: "scene", summary: "scene one", start: 0, end: 0.1, ok: true, label: "one" },
      { index: 1, action: "click", summary: "click #go", start: 0.1, end: 1, ok: true },
      { index: 2, action, summary: action === "wait" ? "wait 40000ms" : "wait for ul.done", start: 1, end: 41, ok: true },
      { index: 3, action: "click", summary: "click #next", start: 41, end: 42, ok: true },
    ],
  };
  fs.writeFileSync(path.join(dir, "take.json"), JSON.stringify(take));
}
const steps = (action: "waitFor" | "wait") => `steps:
  - { action: scene, label: one }
  - { action: click, selector: "#go" }
  - ${action === "wait" ? "{ action: wait, ms: 40000 }" : '{ action: waitFor, selector: "ul.done" }'}
  - { action: click, selector: "#next" }
`;
const stallLine = (lines: string[]) => lines.find((l) => /stalled over/.test(l));

test("a stall compressIdle removes does not fail the check; the same stall without it does", () => {
  const dir = tmp();
  try {
    stalledTake(dir, "waitFor");
    const squeezed = check(dir, manifest(dir, `name: demo\nurl: http://localhost:3000\npreset: draft\ncompressIdle: true\n${steps("waitFor")}`));
    assert.equal(stallLine(squeezed.lines), undefined, squeezed.lines.join("\n"));
    const raw = check(dir, manifest(dir, `name: demo\nurl: http://localhost:3000\npreset: draft\n${steps("waitFor")}`));
    assert.match(stallLine(raw.lines) ?? "", /^FAIL .*40\.0s/, raw.lines.join("\n"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a deliberate wait is never compressed, so check does not count it as a stall either way", () => {
  const dir = tmp();
  try {
    stalledTake(dir, "wait");
    const c = check(dir, manifest(dir, `name: demo\nurl: http://localhost:3000\npreset: draft\ncompressIdle: true\n${steps("wait")}`));
    assert.equal(stallLine(c.lines), undefined, "a wait is pacing the author asked for, not a stall");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- (a) validate says the real video size, and names unknown keys ----------

const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const validate = (file: string) => spawnSync(process.execPath, [tsx, path.resolve("src/cli.ts"), "validate", file], { encoding: "utf8" });

test("validate gives the video the preset delivers, and the viewport only as the page fitted into it", () => {
  const dir = tmp();
  try {
    const f = path.join(dir, "v.yaml");
    fs.writeFileSync(f, `name: v\nurl: http://localhost:3000\npreset: post-landscape\nviewport: { width: 1440, height: 900 }\nsteps:\n  - { action: scene, label: one }\n`);
    const r = validate(f);
    assert.equal(r.status, 0, r.stderr);
    // render always fits the page into the preset's frame (src/render.ts), so 1920×1080 is what comes out
    assert.match(r.stdout, /video 1920×1080 \(page 1440×900, fitted into 1920×1080/);
    assert.doesNotMatch(r.stdout, /video 1440×/, "the page size is not the video size");
    assert.match(r.stdout, /the page records at 1440×900 and is fitted, with margins, into post-landscape's 1920×1080 video/);
    // No viewport: one plain line, no warning about it.
    fs.writeFileSync(f, `name: v\nurl: http://localhost:3000\npreset: post-square\nsteps:\n  - { action: scene, label: one }\n`);
    const plain = validate(f);
    assert.match(plain.stdout, /video 1080×1080 \(captions off — the page fills the frame\)/);
    assert.doesNotMatch(plain.stdout, /viewport/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a key the manifest does not know is said out loud, with the nearest real one", () => {
  const dir = tmp();
  try {
    const m = manifest(dir, `name: k\nurl: http://localhost:3000\ncaptionz: false\noutputs:\n  thumbnale: true\nsteps:\n  - { action: scene, label: one }\n`);
    const w = warnings(m);
    assert.ok(w.includes("`captionz` is not a manifest key, so it is ignored — did you mean `captions`?"), w.join("\n"));
    assert.ok(w.includes("`outputs.thumbnale` is not a manifest key, so it is ignored — did you mean `outputs.thumbnail`?"), w.join("\n"));
    // A clean manifest says nothing of the kind, and nothing far from a real key gets a guess.
    assert.equal(warnings(manifest(dir, `name: k\nurl: http://localhost:3000\nsteps:\n  - { action: scene, label: one }\n`)).filter((l) => /not a manifest key/.test(l)).length, 0);
    const odd = warnings(manifest(dir, `name: k\nurl: http://localhost:3000\nzzqxw: 1\nsteps:\n  - { action: scene, label: one }\n`));
    assert.ok(odd.includes("`zzqxw` is not a manifest key, so it is ignored"), odd.join("\n"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- (b) the contact sheet: one frame per moment, all the way to the end ----------

test("the contact sheet takes one frame per moment and reaches the last frame", () => {
  const dir = tmp();
  try {
    const mp4 = clip(dir, 7.2);
    const last = lastFrameTime(mp4);
    assert.ok(Math.abs(last - (7.2 - 1 / 30)) < 0.02, `last frame at ${last}`);
    const times = contactTimes(last, 2);
    assert.deepEqual(times.map((t) => +t.toFixed(2)), [0, 2, 4, 6, +last.toFixed(2)]);
    // What ffmpeg actually picks with that expression: exactly one frame for each moment.
    const r = spawnSync(ffmpegBin(), ["-hide_banner", "-i", mp4, "-vf", `select='${contactSelect(times)}',showinfo`, "-vsync", "0", "-f", "null", "-"], { encoding: "utf8" });
    const picked = [...String(r.stderr).matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
    assert.equal(picked.length, times.length, `picked ${picked.join(", ")}`);
    assert.equal(new Set(picked).size, picked.length, "no moment twice");
    assert.ok(Math.abs(picked.at(-1)! - last) < 0.001, "the final cell is the final frame");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- (d) the live Watch screen fits the recording presets ----------

test("a live Watch session keeps its controls on screen at every recording preset, and the phone layout is untouched", { timeout: 60_000 }, async () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ui", "watch.html"), "utf8");
  const at = (n: number) => new Date(1.79e12 + n * 1000).toISOString();
  const steps = [1, 2, 3].map((n) => ({ n, scenario: "Book a room", intent: `Step ${n}`, expect: "the next page", result: "pass", note: "ok", startedAt: at(n), endedAt: at(n + 0.8), t: n * 1000, tEnd: n * 1000 + 800, url: "http://app/", screenshot: null }));
  const state = { id: "s", title: "Larkspur · Book a room", live: true, video: null, speed: "step", waiting: true, hold: false, next: 0, scenario: "Book a room", startedAt: at(0), steps, flags: [], fix: { pending: null, last: null } };
  // The page sizes the presets record at: canvas minus the caption band, divided by the page scale.
  const sizes: [string, number, number][] = [["preview-fast / post-landscape", 960, 465], ["draft", 960, 464], ["docs-gif", 960, 533], ["post-square", 675, 600], ["post-vertical", 540, 900], ["landscape at scale 1.333", 1440, 698]];
  const browser = await chromium.launch({ headless: true });
  try {
    const open = async (width: number, height: number) => {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.route("http://watch.test/**", (route) => {
        const u = new URL(route.request().url());
        if (u.pathname === "/watch/s") return route.fulfill({ contentType: "text/html", body: html.replace("</head>", `<script>window.__retakeToken="t"</script></head>`) });
        if (u.pathname === "/brand.css") return route.fulfill({ contentType: "text/css", body: fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ui", "brand.css"), "utf8") });
        if (u.pathname === "/api/watch/s/stream") return route.fulfill({ contentType: "text/event-stream", body: `event: state\ndata: ${JSON.stringify(state)}\n\n` });
        if (u.pathname.endsWith("live.mjpg")) return route.fulfill({ status: 404, body: "" });
        return route.fulfill({ contentType: "application/json", body: "{}" });
      });
      await page.goto("http://watch.test/watch/s");
      await page.waitForFunction(() => document.querySelectorAll("#steps .m").length === 3 && document.getElementById("now")?.textContent);
      return page;
    };
    for (const [name, width, height] of sizes) {
      const page = await open(width, height);
      const m = await page.evaluate(() => ({ act: document.querySelector(".act")!.getBoundingClientRect().bottom, now: document.getElementById("now")!.getBoundingClientRect().top, vh: innerHeight }));
      assert.ok(m.act <= m.vh, `${name}: Next / Unclear end at ${Math.round(m.act)}px, below a ${m.vh}px page`);
      await page.close();
    }
    // A phone is tall, so its column never narrows: the full width, as #6 left it.
    const phone = await open(390, 844);
    assert.equal(await phone.evaluate(() => Math.round(document.querySelector("main")!.getBoundingClientRect().width)), 390);
    // A tall desktop window is not narrowed either.
    const desk = await open(1440, 1100);
    assert.equal(await desk.evaluate(() => Math.round(document.querySelector("main")!.getBoundingClientRect().width)), 1180);
  } finally { await browser.close(); }
});
