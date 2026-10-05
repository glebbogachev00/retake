/** A new product in one step. Everything setup decides is read off two things
    — the app and one loved video — so these pin the reading: a card is told
    from an app, an inset from a dark site, and a secret's VALUE never leaves
    its file. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { EnvSpec } from "../src/recording-env.js";
import {
  briefMarkdown, contrast, dominant, environmentYaml, hexRgb, isLocal, isolatedPort, productName,
  reachingVariables, readLook, routineFor, startOnPort, straightSides, type Frame, type Rgb,
} from "../src/setup.js";

const W = 96, H = 54;

function frame(paint: (x: number, y: number) => Rgb): Frame {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = paint(x, y);
    const i = (y * W + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  }
  return { width: W, height: H, px };
}

const LIGHT: Rgb = [251, 251, 251];
const GREEN: Rgb = [44, 90, 61];
// A card: flat light ground, a short green title in the middle.
const card = frame((x, y) => (y > 24 && y < 30 && x > 30 && x < 66 ? GREEN : LIGHT));
// An inset: green matte, a busy app in a rectangle 8px in from each side.
const inset = frame((x, y) => (x < 8 || x >= W - 8 || y < 5 || y >= H - 5 ? GREEN : [(x * 7) % 255, (y * 11) % 255, 200]));
// A dark site: black to its edges, text starting wherever it starts.
const darkSite = frame((x, y) => (y % 6 === 0 && x > 3 + ((y * 13) % 30) && x < 80 ? [230, 230, 230] : [3, 3, 3]));

test("a card and an inset are read as the north star's look", () => {
  const look = readLook({ intro: card, body: inset, outro: card }, { width: 1920, height: 1080 });
  assert.equal(look.style, "showcase");
  assert.equal(look.cards, true);
  assert.equal(look.card?.background, "#fbfbfb");
  assert.equal(look.card?.ink, "#2c5a3d", "the brand inks its card in its matte colour");
  assert.equal(look.theme?.background, "#2c5a3d");
});

test("a dark site is full bleed, not an inset on black", () => {
  assert.equal(straightSides(darkSite, [3, 3, 3]), false);
  const look = readLook({ intro: darkSite, body: darkSite, outro: darkSite }, { width: 1920, height: 1080 });
  assert.equal(look.style, "fullscreen");
  assert.equal(look.theme, undefined);
  assert.equal(look.cards, false, "a body that never changes is not a card");
});

test("a tall video is the mobile shape", () => {
  assert.equal(readLook({ intro: inset, body: inset, outro: inset }, { width: 1080, height: 1920 }).style, "mobile");
});

test("dominant returns a real colour from the frame, and its share", () => {
  const d = dominant(card);
  assert.deepEqual(d.color, LIGHT);
  assert.ok(d.share > 0.9);
  assert.ok(contrast(hexRgb("#2c5a3d"), LIGHT) > 4.5);
});

test("names come from the project folder, or the site", () => {
  assert.equal(productName("http://localhost:3000/app", "/Users/x/capture-local"), "capture-local");
  assert.equal(productName("https://www.useretake.app/"), "useretake");
  assert.equal(isLocal("http://localhost:3179/app"), true);
  assert.equal(isLocal("http://app.test/"), true);
  assert.equal(isLocal("https://bingx.com/"), false);
});

test("the isolated instance is a different port — a different origin", () => {
  assert.equal(isolatedPort(3160, (p) => p === 3179), 3180);
  assert.notEqual(isolatedPort(3160, () => false), 3160);
});

test("the project's own start command, moved to our port", () => {
  assert.equal(startOnPort("npm run dev", "next dev", 3179), "PORT=3179 npm run dev -- --port 3179");
  assert.equal(startOnPort("npm run dev", "node server.mjs", 4319), "PORT=4319 npm run dev");
  assert.equal(startOnPort("vercel dev", "vercel dev", 4319), "vercel dev --listen 4319");
});

test("variables that reach a real account are named — their values never read out", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retake-setup-"));
  fs.writeFileSync(path.join(dir, ".env.local"), [
    "UPSTASH_REDIS_REST_TOKEN=very-secret-value",
    "BLOB_READ_WRITE_TOKEN=another-secret",
    "export DATABASE_URL=postgres://u:p@host/db",
    "APP_PASSWORD=hunter2",
    "NEXT_PUBLIC_TITLE=Capture",
    "EMPTY_TOKEN=",
  ].join("\n"));
  const names = reachingVariables(dir);
  assert.deepEqual(names, ["APP_PASSWORD", "BLOB_READ_WRITE_TOKEN", "DATABASE_URL", "UPSTASH_REDIS_REST_TOKEN"]);
  const yaml = environmentYaml({ name: "capture", command: "PORT=3179 npm run dev", cwd: dir, port: 3179, blank: names, path: "/app", present: ["#new"] });
  for (const secret of ["very-secret-value", "another-secret", "hunter2", "postgres://"]) assert.ok(!yaml.includes(secret), `${secret} leaked into the environment file`);
  const spec = EnvSpec.parse(YAML.parse(yaml));
  assert.equal(spec.start.env.APP_PASSWORD, "", "blanked, not unset — an explicit empty beats .env.local");
  assert.equal(spec.reset.restart, true);
  assert.deepEqual(spec.expect?.absent, []);
});

test("the brief carries the app, the north star and the selectors seen", () => {
  const md = briefMarkdown({
    name: "acme", title: "Acme", url: "http://localhost:4319/app", reference: "demos/reference/acme.mp4", facts: "1920×1080 · 36s · narrated",
    local: true, environment: "demos/environments/acme.yaml", blank: ["DATABASE_URL"], seen: [{ selector: "#new-note", text: "New note" }], hasStyle: false,
  });
  assert.match(md, /demos\/reference\/acme\.mp4/);
  assert.match(md, /`#new-note`/);
  assert.match(md, /`DATABASE_URL`/);
  assert.match(md, /Never open a browser tab on it yourself/);
});

test("the routine takes the look, a narrated north star gets a voice", () => {
  const look = readLook({ intro: card, body: inset, outro: card }, { width: 1920, height: 1080 });
  const r = routineFor({ look, narrated: true, brief: "demos/acme.md", environment: "demos/environments/acme.yaml", logo: "demos/brand/acme-mark.svg" });
  assert.equal(r.cards, true);
  assert.equal(r.mode, "launch");
  assert.equal(r.card?.logo, "demos/brand/acme-mark.svg");
  assert.equal(r.voice, "andrew");
  assert.equal(r.captions, false);
  assert.equal(r.environment, "demos/environments/acme.yaml");
  // The workspace's own voice and pace carry over to its next product.
  assert.equal(routineFor({ look, narrated: true, brief: "b", inheritVoice: { voice: "ryan", rate: -8 } }).rate, -8);
  assert.equal(routineFor({ narrated: false, brief: "b" }).voice, "silent");
});
